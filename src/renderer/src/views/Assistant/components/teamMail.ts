/**
 * 留言列表和阅读视图共用的一份「整理过的留言」：谁发给谁、什么类型、标题、摘要、正文。
 */

import { PRODUCER, type TeamMail, type TeamStateView } from '@core/shared/agentTeam'

import { parseTeamMail, type MailExtra } from './teamBoardText'
import { mailRole, summarizeReport, type MailRole } from './teamBoardView'

export interface MailItem {
  mail: TeamMail
  role: MailRole
  fromProducer: boolean
  title: string
  summary: string
  /** 展开后渲染的 Markdown（去掉了客套话和给模型看的附注） */
  body: string
  sections: number
  model?: string
  extras: MailExtra[]
  /** 长到值得开阅读视图 */
  long: boolean
  /** 制作人发出去、对方还没读到的：这是唯一有用的回执 */
  unread: boolean
}

const key = (name: string): string => name.trim().toLowerCase()

/** 指令往往一大段，收起时只露第一句 */
function firstSentence(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const match = flat.match(/^.{4,}?[。！？!?]/)
  const sentence = match ? match[0] : flat
  return sentence.length > 90 ? `${sentence.slice(0, 89)}…` : sentence
}

export function mailItems(team: TeamStateView, selected: string | null): MailItem[] {
  return team.mail
    .filter((mail) => !selected || key(mail.from) === selected || key(mail.to) === selected)
    .slice()
    .reverse()
    .map((mail) => {
      const view = parseTeamMail(mail.text, mail.from)
      const role = mailRole(mail)
      const fromProducer = key(mail.from) === PRODUCER
      const report = summarizeReport(view.body)
      const isReport = role === 'delivery' || report.sections > 0
      const summary = isReport
        ? report.summary
        : role === 'stopped'
          ? view.body
          : firstSentence(report.body || view.body)
      return {
        mail,
        role,
        fromProducer,
        title: isReport ? report.title : '',
        summary,
        body: report.body || view.body,
        sections: report.sections,
        ...(view.model ? { model: view.model } : {}),
        extras: view.extras,
        long: report.body.length > 600 || report.sections >= 3,
        unread: fromProducer && !mail.readAt
      }
    })
}
