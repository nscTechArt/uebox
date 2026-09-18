#!/usr/bin/env node

const { execSync } = require('child_process')
const fs = require('fs')
const path = require('path')

/**
 * 获取近一周的Git提交记录并生成文档
 */
class GitLogGenerator {
  constructor() {
    this.projectRoot = process.cwd()
    this.devDir = path.join(this.projectRoot, 'dev')
  }

  /**
   * 确保dev目录存在
   */
  ensureDevDirectory() {
    if (!fs.existsSync(this.devDir)) {
      fs.mkdirSync(this.devDir, { recursive: true })
      console.log('✅ 创建dev目录')
    }
  }

  /**
   * 获取近一周的Git提交记录
   * @returns {Array} 提交记录数组
   */
  getWeeklyCommits() {
    try {
      // 获取一周前的日期
      const oneWeekAgo = new Date()
      oneWeekAgo.setDate(oneWeekAgo.getDate() - 14)
      const sinceDate = oneWeekAgo.toISOString().split('T')[0]

      // 执行git log命令获取提交记录
      const gitLogCommand = `git log --since="${sinceDate}" --pretty=format:"%H|%an|%ae|%ad|%s" --date=iso`

      console.log(`🔍 获取自 ${sinceDate} 以来的提交记录...`)

      const output = execSync(gitLogCommand, {
        encoding: 'utf8',
        cwd: this.projectRoot
      })

      if (!output.trim()) {
        console.log('📝 近一周没有提交记录')
        return []
      }

      // 解析提交记录
      const commits = output
        .trim()
        .split('\n')
        .map((line) => {
          const [hash, author, email, date, message] = line.split('|')
          return {
            hash: hash.substring(0, 8), // 短hash
            author,
            email,
            date: new Date(date).toLocaleString('zh-CN'),
            message: message || '无提交信息'
          }
        })

      console.log(`📊 找到 ${commits.length} 条提交记录`)
      return commits
    } catch (error) {
      console.error('❌ 获取Git提交记录失败:', error.message)

      // 检查是否在Git仓库中
      try {
        execSync('git rev-parse --git-dir', { cwd: this.projectRoot, stdio: 'ignore' })
      } catch {
        throw new Error('当前目录不是Git仓库')
      }

      throw error
    }
  }

  /**
   * 生成Markdown文档
   * @param {Array} commits 提交记录数组
   * @returns {string} Markdown内容
   */
  generateMarkdown(commits) {
    const now = new Date()
    const weekAgo = new Date()
    weekAgo.setDate(weekAgo.getDate() - 7)

    let markdown = `# Git 提交记录报告\n\n`
    markdown += `**生成时间**: ${now.toLocaleString('zh-CN')}\n`
    markdown += `**统计周期**: ${weekAgo.toLocaleDateString('zh-CN')} - ${now.toLocaleDateString('zh-CN')}\n`
    markdown += `**提交总数**: ${commits.length}\n\n`

    if (commits.length === 0) {
      markdown += `## 📝 提交记录\n\n暂无提交记录\n\n`
      return markdown
    }

    // 按作者统计
    const authorStats = {}
    commits.forEach((commit) => {
      if (!authorStats[commit.author]) {
        authorStats[commit.author] = {
          count: 0,
          commits: []
        }
      }
      authorStats[commit.author].count++
      authorStats[commit.author].commits.push(commit)
    })

    // 作者统计
    markdown += `## 👥 作者统计\n\n`
    Object.entries(authorStats)
      .sort(([, a], [, b]) => b.count - a.count)
      .forEach(([author, stats]) => {
        markdown += `- **${author}**: ${stats.count} 次提交\n`
      })

    markdown += `\n## 📋 详细提交记录\n\n`

    // 按日期分组
    const commitsByDate = {}
    commits.forEach((commit) => {
      const date = commit.date.split(' ')[0] // 只取日期部分
      if (!commitsByDate[date]) {
        commitsByDate[date] = []
      }
      commitsByDate[date].push(commit)
    })

    // 按日期倒序排列
    Object.entries(commitsByDate)
      .sort(([a], [b]) => new Date(b) - new Date(a))
      .forEach(([date, dayCommits]) => {
        markdown += `### 📅 ${date}\n\n`

        dayCommits.forEach((commit) => {
          markdown += `- **[${commit.hash}]** ${commit.message}\n`
          markdown += `  - 👤 作者: ${commit.author} (${commit.email})\n`
          markdown += `  - 🕐 时间: ${commit.date}\n\n`
        })
      })

    // 添加统计摘要
    markdown += `## 📊 统计摘要\n\n`
    markdown += `- 总提交数: ${commits.length}\n`
    markdown += `- 参与人数: ${Object.keys(authorStats).length}\n`
    markdown += `- 活跃天数: ${Object.keys(commitsByDate).length}\n`
    markdown += `- 平均每日提交: ${(commits.length / 7).toFixed(1)}\n\n`

    markdown += `---\n`
    markdown += `*此报告由 generate-git-log.js 自动生成*\n`

    return markdown
  }

  /**
   * 保存文档到文件
   * @param {string} content Markdown内容
   */
  saveDocument(content) {
    const timestamp = new Date().toISOString().split('T')[0]
    const filename = `git-commits-${timestamp}.md`
    const filepath = path.join(this.devDir, filename)

    fs.writeFileSync(filepath, content, 'utf8')
    console.log(`📄 文档已保存到: ${filepath}`)

    // 同时保存一个最新版本
    const latestPath = path.join(this.devDir, 'git-commits-latest.md')
    fs.writeFileSync(latestPath, content, 'utf8')
    console.log(`📄 最新版本已保存到: ${latestPath}`)
  }

  /**
   * 执行主流程
   */
  async run() {
    try {
      console.log('🚀 开始生成Git提交记录文档...\n')

      // 1. 确保dev目录存在
      this.ensureDevDirectory()

      // 2. 获取提交记录
      const commits = this.getWeeklyCommits()

      // 3. 生成Markdown文档
      const markdown = this.generateMarkdown(commits)

      // 4. 保存文档
      this.saveDocument(markdown)

      console.log('\n✅ Git提交记录文档生成完成!')
    } catch (error) {
      console.error('\n❌ 生成失败:', error.message)
      process.exit(1)
    }
  }
}

// 如果直接运行此脚本
if (require.main === module) {
  const generator = new GitLogGenerator()
  generator.run()
}

module.exports = GitLogGenerator
