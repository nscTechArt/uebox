import Database from 'better-sqlite3'
import { beforeEach, describe, expect, it } from 'vitest'

import { runInTransaction, transaction } from './dbUtils'

/**
 * 事务原语的行为锁定。
 *
 * 重点是最后那条并发回归：旧实现（手写 BEGIN + await + COMMIT）会让一个 handler
 * 的事务窗口跨越事件循环，把另一个 handler 的**非事务写**卷进来一起回滚。
 * 那条用例对旧实现必红，对新实现必绿，测试体一字不用改。
 */

let db: Database.Database

const keys = (): string[] =>
  (db.prepare('SELECT k FROM kv ORDER BY k').all() as Array<{ k: string }>).map((r) => r.k)

const insert = (d: Database.Database, k: string): void => {
  d.prepare('INSERT INTO kv(k) VALUES(?)').run(k)
}

beforeEach(() => {
  db = new Database(':memory:')
  db.exec('CREATE TABLE kv (k TEXT PRIMARY KEY)')
})

describe('runInTransaction', () => {
  it('提交后数据可见，并原样返回回调的返回值', () => {
    const result = runInTransaction(db, (d) => {
      insert(d, 'a')
      return 'done'
    })

    expect(result).toBe('done')
    expect(keys()).toEqual(['a'])
  })

  it('回调抛错则整体回滚，且事务状态被清干净', () => {
    expect(() =>
      runInTransaction(db, (d) => {
        insert(d, 'a')
        throw new Error('boom')
      })
    ).toThrow('boom')

    expect(keys()).toEqual([])
    expect(db.inTransaction).toBe(false)
  })

  it('嵌套调用走 SAVEPOINT：内层回滚不影响外层', () => {
    runInTransaction(db, (outer) => {
      insert(outer, 'outer')
      try {
        runInTransaction(outer, (inner) => {
          insert(inner, 'inner')
          throw new Error('inner failed')
        })
      } catch {
        // 内层失败被外层吞掉，外层继续提交
      }
    })

    expect(keys()).toEqual(['outer'])
    expect(db.inTransaction).toBe(false)
  })

  it('嵌套不再抛 "cannot start a transaction within a transaction"', () => {
    expect(() =>
      runInTransaction(db, (outer) => {
        runInTransaction(outer, (inner) => insert(inner, 'nested'))
      })
    ).not.toThrow()

    expect(keys()).toEqual(['nested'])
  })

  it('异步回调被驱动直接拒绝，且不留下悬挂事务', () => {
    // 类型层面：这个调用命中 TransactionCallbackMustBeSynchronous 重载，
    // 返回值一旦被使用就会在 typecheck 阶段报错。运行时则由驱动兜底抛错。
    expect(() =>
      runInTransaction(db, async () => {
        /* 空 */
      })
    ).toThrow(/cannot return a promise/i)

    expect(db.inTransaction).toBe(false)
  })
})

describe('transaction 兼容外壳', () => {
  it('同步回调照常工作，返回 Promise', async () => {
    await expect(transaction(db, (d) => insert(d, 'a'))).resolves.toBeUndefined()
    expect(keys()).toEqual(['a'])
  })

  it('回调抛错转成 reject，调用点的 try/catch 照旧生效', async () => {
    await expect(
      transaction(db, (d) => {
        insert(d, 'a')
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')

    expect(keys()).toEqual([])
  })

  it('回归：事务窗口不会跨越事件循环，别人的非事务写不会被卷进来', async () => {
    // handler A：旧写法 —— 事务回调是异步的。
    // 回调体本身全同步，避免留下无人接管的悬挂 Promise，断言才是确定性的。
    const asyncCallback = async (d: Database.Database): Promise<void> => {
      insert(d, 'A')
    }
    const a = transaction(db, asyncCallback as unknown as (d: Database.Database) => void)

    // 关键断言：transaction() 返回时，连接上不能还开着事务。
    // 旧实现此刻 inTransaction === true —— 别的 IPC handler 这时候的普通写
    // （crud.ts / assetFolder.ts 里大量裸调的 update/delete）会掉进这个窗口，
    // 等本事务最终 ROLLBACK 时被一起静默撤销。
    expect(db.inTransaction).toBe(false)

    // handler B：另一个 IPC 的普通写，不在任何事务里
    insert(db, 'B')

    await expect(a).rejects.toThrow(/cannot return a promise/i)

    // B 的写活下来了；A 的写随它自己的事务回滚掉
    expect(keys()).toEqual(['B'])
  })
})
