import * as fs from 'fs'
import * as path from 'path'
import ExcelJS from 'exceljs'
import { ConfigService } from './config'
import { wcdbService } from './wcdbService'

export interface GroupChatInfo {
  username: string
  displayName: string
  memberCount: number
  avatarUrl?: string
}

export interface GroupMember {
  username: string
  displayName: string
  avatarUrl?: string
}

export interface GroupMessageRank {
  member: GroupMember
  messageCount: number
}

export interface GroupActiveHours {
  hourlyDistribution: Record<number, number>
}

export interface MediaTypeCount {
  type: number
  name: string
  count: number
}

export interface GroupMediaStats {
  typeCounts: MediaTypeCount[]
  total: number
}

class GroupAnalyticsService {
  private configService: ConfigService

  constructor() {
    this.configService = new ConfigService()
  }

  // 并发控制：限制同时执行的 Promise 数量
  private async parallelLimit<T, R>(
    items: T[],
    limit: number,
    fn: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = new Array(items.length)
    let currentIndex = 0

    async function runNext(): Promise<void> {
      while (currentIndex < items.length) {
        const index = currentIndex++
        results[index] = await fn(items[index], index)
      }
    }

    const workers = Array(Math.min(limit, items.length))
      .fill(null)
      .map(() => runNext())

    await Promise.all(workers)
    return results
  }

  private cleanAccountDirName(name: string): string {
    const trimmed = name.trim()
    if (!trimmed) return trimmed
    if (trimmed.toLowerCase().startsWith('wxid_')) {
      const match = trimmed.match(/^(wxid_[^_]+)/i)
      if (match) return match[1]
    }
    return trimmed
  }

  private async ensureConnected(): Promise<{ success: boolean; error?: string }> {
    const wxid = this.configService.get('myWxid')
    const dbPath = this.configService.get('dbPath')
    const decryptKey = this.configService.get('decryptKey')
    if (!wxid) return { success: false, error: '未配置微信ID' }
    if (!dbPath) return { success: false, error: '未配置数据库路径' }
    if (!decryptKey) return { success: false, error: '未配置解密密钥' }

    const cleanedWxid = this.cleanAccountDirName(wxid)
    const ok = await wcdbService.open(dbPath, decryptKey, cleanedWxid)
    if (!ok) return { success: false, error: 'WCDB 打开失败' }
    return { success: true }
  }

  private looksLikeHex(s: string): boolean {
    if (s.length % 2 !== 0) return false
    return /^[0-9a-fA-F]+$/.test(s)
  }

  private looksLikeBase64(s: string): boolean {
    if (s.length % 4 !== 0) return false
    return /^[A-Za-z0-9+/=]+$/.test(s)
  }

  /**
   * 解析 ext_buffer 二进制数据，提取群成员的群昵称
   */
  private parseGroupNicknamesFromExtBuffer(buffer: Buffer): Map<string, string> {
    const nicknameMap = new Map<string, string>()

    try {
      const raw = buffer.toString('utf8')
      const wxidPattern = /wxid_[a-z0-9_]+/gi
      const wxids = raw.match(wxidPattern) || []

      for (const wxid of wxids) {
        const wxidLower = wxid.toLowerCase()
        const wxidIndex = raw.toLowerCase().indexOf(wxidLower)
        if (wxidIndex === -1) continue

        const afterWxid = raw.slice(wxidIndex + wxid.length)
        let nickname = ''
        let foundStart = false

        for (let i = 0; i < afterWxid.length && i < 100; i++) {
          const char = afterWxid[i]
          const code = char.charCodeAt(0)
          const isPrintable = (
            (code >= 0x4E00 && code <= 0x9FFF) ||
            (code >= 0x3000 && code <= 0x303F) ||
            (code >= 0xFF00 && code <= 0xFFEF) ||
            (code >= 0x20 && code <= 0x7E)
          )

          if (isPrintable && code !== 0x01 && code !== 0x18) {
            foundStart = true
            nickname += char
          } else if (foundStart) {
            break
          }
        }

        nickname = nickname.trim().replace(/[\x00-\x1F\x7F]/g, '')
        if (nickname && nickname.length < 50) {
          nicknameMap.set(wxidLower, nickname)
        }
      }
    } catch (e) {
      console.error('Failed to parse ext_buffer:', e)
    }

    return nicknameMap
  }

  /**
   * 从 contact.db 的 chat_room 表获取群成员的群昵称
   */
  private async getGroupNicknamesForRoom(chatroomId: string): Promise<Map<string, string>> {
    try {
      const sql = `SELECT ext_buffer FROM chat_room WHERE username = '${chatroomId.replace(/'/g, "''")}'`
      const result = await wcdbService.execQuery('contact', null, sql)

      if (!result.success || !result.rows || result.rows.length === 0) {
        return new Map<string, string>()
      }

      let extBuffer = result.rows[0].ext_buffer

      if (typeof extBuffer === 'string') {
        if (this.looksLikeHex(extBuffer)) {
          extBuffer = Buffer.from(extBuffer, 'hex')
        } else if (this.looksLikeBase64(extBuffer)) {
          extBuffer = Buffer.from(extBuffer, 'base64')
        } else {
          try {
            extBuffer = Buffer.from(extBuffer, 'hex')
          } catch {
            extBuffer = Buffer.from(extBuffer, 'base64')
          }
        }
      }

      if (!extBuffer || !Buffer.isBuffer(extBuffer)) {
        return new Map<string, string>()
      }

      return this.parseGroupNicknamesFromExtBuffer(extBuffer)
    } catch (e) {
      console.error('getGroupNicknamesForRoom error:', e)
      return new Map<string, string>()
    }
  }

  private escapeCsvValue(value: string): string {
    if (value == null) return ''
    const str = String(value)
    if (/[",\n\r]/.test(str)) {
      return `"${str.replace(/"/g, '""')}"`
    }
    return str
  }

  private normalizeGroupNickname(value: string, wxid: string, fallback: string): string {
    const trimmed = (value || '').trim()
    if (!trimmed) return fallback
    if (/^["'@]+$/.test(trimmed)) return fallback
    if (trimmed.toLowerCase() === (wxid || '').toLowerCase()) return fallback
    return trimmed
  }

  private sanitizeWorksheetName(name: string): string {
    const cleaned = (name || '').replace(/[*?:\\/\\[\\]]/g, '_').trim()
    const limited = cleaned.slice(0, 31)
    return limited || 'Sheet1'
  }

  private formatDateTime(date: Date): string {
    const pad = (value: number) => String(value).padStart(2, '0')
    const year = date.getFullYear()
    const month = pad(date.getMonth() + 1)
    const day = pad(date.getDate())
    const hour = pad(date.getHours())
    const minute = pad(date.getMinutes())
    const second = pad(date.getSeconds())
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`
  }

  async getGroupChats(): Promise<{ success: boolean; data?: GroupChatInfo[]; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const sessionResult = await wcdbService.getSessions()
      if (!sessionResult.success || !sessionResult.sessions) {
        return { success: false, error: sessionResult.error || '获取会话失败' }
      }

      const rows = sessionResult.sessions as Record<string, any>[]
      const groupIds = rows
        .map((row) => row.username || row.user_name || row.userName || '')
        .filter((username) => username.includes('@chatroom'))

      const [displayNames, avatarUrls, memberCounts] = await Promise.all([
        wcdbService.getDisplayNames(groupIds),
        wcdbService.getAvatarUrls(groupIds),
        wcdbService.getGroupMemberCounts(groupIds)
      ])

      const groups: GroupChatInfo[] = []
      for (const groupId of groupIds) {
        groups.push({
          username: groupId,
          displayName: displayNames.success && displayNames.map
            ? (displayNames.map[groupId] || groupId)
            : groupId,
          memberCount: memberCounts.success && memberCounts.map && typeof memberCounts.map[groupId] === 'number'
            ? memberCounts.map[groupId]
            : 0,
          avatarUrl: avatarUrls.success && avatarUrls.map ? avatarUrls.map[groupId] : undefined
        })
      }

      groups.sort((a, b) => b.memberCount - a.memberCount)
      return { success: true, data: groups }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMembers(chatroomId: string): Promise<{ success: boolean; data?: GroupMember[]; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const result = await wcdbService.getGroupMembers(chatroomId)
      if (!result.success || !result.members) {
        return { success: false, error: result.error || '获取群成员失败' }
      }

      const members = result.members as { username: string; avatarUrl?: string }[]
      const usernames = members.map((m) => m.username)
      const displayNames = await wcdbService.getDisplayNames(usernames)

      const data: GroupMember[] = members.map((m) => ({
        username: m.username,
        displayName: displayNames.success && displayNames.map ? (displayNames.map[m.username] || m.username) : m.username,
        avatarUrl: m.avatarUrl
      }))

      return { success: true, data }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMessageRanking(chatroomId: string, limit: number = 20, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: GroupMessageRank[]; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const result = await wcdbService.getGroupStats(chatroomId, startTime || 0, endTime || 0)
      if (!result.success || !result.data) return { success: false, error: result.error || '聚合失败' }

      const d = result.data
      const sessionData = d.sessions[chatroomId]
      if (!sessionData || !sessionData.senders) return { success: true, data: [] }

      const idMap = d.idMap || {}
      const senderEntries = Object.entries(sessionData.senders as Record<string, number>)

      const rankings: GroupMessageRank[] = senderEntries
        .map(([id, count]) => {
          const username = idMap[id] || id
          return {
            member: { username, displayName: username }, // Display name will be resolved below
            messageCount: count
          }
        })
        .sort((a, b) => b.messageCount - a.messageCount)
        .slice(0, limit)

      // 批量获取显示名称和头像
      const usernames = rankings.map(r => r.member.username)
      const [names, avatars] = await Promise.all([
        wcdbService.getDisplayNames(usernames),
        wcdbService.getAvatarUrls(usernames)
      ])

      for (const rank of rankings) {
        if (names.success && names.map && names.map[rank.member.username]) {
          rank.member.displayName = names.map[rank.member.username]
        }
        if (avatars.success && avatars.map && avatars.map[rank.member.username]) {
          rank.member.avatarUrl = avatars.map[rank.member.username]
        }
      }

      return { success: true, data: rankings }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }



  async getGroupActiveHours(chatroomId: string, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: GroupActiveHours; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const result = await wcdbService.getGroupStats(chatroomId, startTime || 0, endTime || 0)
      if (!result.success || !result.data) return { success: false, error: result.error || '聚合失败' }

      const hourlyDistribution: Record<number, number> = {}
      for (let i = 0; i < 24; i++) {
        hourlyDistribution[i] = result.data.hourly[i] || 0
      }

      return { success: true, data: { hourlyDistribution } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async getGroupMediaStats(chatroomId: string, startTime?: number, endTime?: number): Promise<{ success: boolean; data?: GroupMediaStats; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const result = await wcdbService.getGroupStats(chatroomId, startTime || 0, endTime || 0)
      if (!result.success || !result.data) return { success: false, error: result.error || '聚合失败' }

      const typeCountsRaw = result.data.typeCounts as Record<string, number>
      const mainTypes = [1, 3, 34, 43, 47, 49]
      const typeNames: Record<number, string> = {
        1: '文本', 3: '图片', 34: '语音', 43: '视频', 47: '表情包', 49: '链接/文件'
      }

      const countsMap = new Map<number, number>()
      let othersCount = 0

      for (const [typeStr, count] of Object.entries(typeCountsRaw)) {
        const type = parseInt(typeStr, 10)
        if (mainTypes.includes(type)) {
          countsMap.set(type, (countsMap.get(type) || 0) + count)
        } else {
          othersCount += count
        }
      }

      const mediaCounts: MediaTypeCount[] = mainTypes
        .map(type => ({
          type,
          name: typeNames[type],
          count: countsMap.get(type) || 0
        }))
        .filter(item => item.count > 0)

      if (othersCount > 0) {
        mediaCounts.push({ type: -1, name: '其他', count: othersCount })
      }

      mediaCounts.sort((a, b) => b.count - a.count)
      const total = mediaCounts.reduce((sum, item) => sum + item.count, 0)

      return { success: true, data: { typeCounts: mediaCounts, total } }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }

  async exportGroupMembers(chatroomId: string, outputPath: string): Promise<{ success: boolean; count?: number; error?: string }> {
    try {
      const conn = await this.ensureConnected()
      if (!conn.success) return { success: false, error: conn.error }

      const exportDate = new Date()
      const exportTime = this.formatDateTime(exportDate)
      const exportVersion = '0.0.2'
      const exportGenerator = 'WeFlow'
      const exportPlatform = 'wechat'

      const groupDisplay = await wcdbService.getDisplayNames([chatroomId])
      const groupName = groupDisplay.success && groupDisplay.map
        ? (groupDisplay.map[chatroomId] || chatroomId)
        : chatroomId

      const groupContact = await wcdbService.getContact(chatroomId)
      const sessionRemark = (groupContact.success && groupContact.contact)
        ? (groupContact.contact.remark || '')
        : ''

      const membersResult = await wcdbService.getGroupMembers(chatroomId)
      if (!membersResult.success || !membersResult.members) {
        return { success: false, error: membersResult.error || '获取群成员失败' }
      }

      const members = membersResult.members as { username: string; avatarUrl?: string }[]
      if (members.length === 0) {
        return { success: false, error: '群成员为空' }
      }

      const usernames = members.map((m) => m.username).filter(Boolean)
      const [displayNames, groupNicknames] = await Promise.all([
        wcdbService.getDisplayNames(usernames),
        this.getGroupNicknamesForRoom(chatroomId)
      ])

      const contactMap = new Map<string, { remark?: string; nickName?: string; alias?: string }>()
      const concurrency = 6
      await this.parallelLimit(usernames, concurrency, async (username) => {
        const result = await wcdbService.getContact(username)
        if (result.success && result.contact) {
          const contact = result.contact as any
          contactMap.set(username, {
            remark: contact.remark || '',
            nickName: contact.nickName || contact.nick_name || '',
            alias: contact.alias || ''
          })
        } else {
          contactMap.set(username, { remark: '', nickName: '', alias: '' })
        }
      })

      const infoTitleRow = ['会话信息']
      const infoRow = ['微信ID', chatroomId, '', '昵称', groupName, '备注', sessionRemark || '', '']
      const metaRow = ['导出工具', exportGenerator, '导出版本', exportVersion, '平台', exportPlatform, '导出时间', exportTime]

      const header = ['微信昵称', '微信备注', '群昵称', 'wxid', '微信号']
      const rows: string[][] = [infoTitleRow, infoRow, metaRow, header]
      const myWxid = this.cleanAccountDirName(this.configService.get('myWxid') || '')

      for (const member of members) {
        const wxid = member.username
        const normalizedWxid = this.cleanAccountDirName(wxid || '')
        const contact = contactMap.get(wxid)
        const fallbackName = displayNames.success && displayNames.map ? (displayNames.map[wxid] || '') : ''
        const nickName = contact?.nickName || fallbackName || ''
        const remark = contact?.remark || ''
        const rawGroupNickname = groupNicknames.get(wxid.toLowerCase()) || ''
        const alias = contact?.alias || ''
        const groupNickname = this.normalizeGroupNickname(
          rawGroupNickname,
          normalizedWxid === myWxid ? myWxid : wxid,
          ''
        )

        rows.push([nickName, remark, groupNickname, wxid, alias])
      }

      const ext = path.extname(outputPath).toLowerCase()
      if (ext === '.csv') {
        const csvLines = rows.map((row) => row.map((cell) => this.escapeCsvValue(cell)).join(','))
        const content = '\ufeff' + csvLines.join('\n')
        fs.writeFileSync(outputPath, content, 'utf8')
      } else {
        const workbook = new ExcelJS.Workbook()
        const sheet = workbook.addWorksheet(this.sanitizeWorksheetName('群成员列表'))

        let currentRow = 1
        const titleCell = sheet.getCell(currentRow, 1)
        titleCell.value = '会话信息'
        titleCell.font = { name: 'Calibri', bold: true, size: 11 }
        titleCell.alignment = { vertical: 'middle', horizontal: 'left' }
        sheet.getRow(currentRow).height = 25
        currentRow++

        sheet.getCell(currentRow, 1).value = '微信ID'
        sheet.getCell(currentRow, 1).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.mergeCells(currentRow, 2, currentRow, 3)
        sheet.getCell(currentRow, 2).value = chatroomId
        sheet.getCell(currentRow, 2).font = { name: 'Calibri', size: 11 }

        sheet.getCell(currentRow, 4).value = '昵称'
        sheet.getCell(currentRow, 4).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.getCell(currentRow, 5).value = groupName
        sheet.getCell(currentRow, 5).font = { name: 'Calibri', size: 11 }

        sheet.getCell(currentRow, 6).value = '备注'
        sheet.getCell(currentRow, 6).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.mergeCells(currentRow, 7, currentRow, 8)
        sheet.getCell(currentRow, 7).value = sessionRemark
        sheet.getCell(currentRow, 7).font = { name: 'Calibri', size: 11 }

        sheet.getRow(currentRow).height = 20
        currentRow++

        sheet.getCell(currentRow, 1).value = '导出工具'
        sheet.getCell(currentRow, 1).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.getCell(currentRow, 2).value = exportGenerator
        sheet.getCell(currentRow, 2).font = { name: 'Calibri', size: 10 }

        sheet.getCell(currentRow, 3).value = '导出版本'
        sheet.getCell(currentRow, 3).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.getCell(currentRow, 4).value = exportVersion
        sheet.getCell(currentRow, 4).font = { name: 'Calibri', size: 10 }

        sheet.getCell(currentRow, 5).value = '平台'
        sheet.getCell(currentRow, 5).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.getCell(currentRow, 6).value = exportPlatform
        sheet.getCell(currentRow, 6).font = { name: 'Calibri', size: 10 }

        sheet.getCell(currentRow, 7).value = '导出时间'
        sheet.getCell(currentRow, 7).font = { name: 'Calibri', bold: true, size: 11 }
        sheet.getCell(currentRow, 8).value = exportTime
        sheet.getCell(currentRow, 8).font = { name: 'Calibri', size: 10 }

        sheet.getRow(currentRow).height = 20
        currentRow++

        const headerRow = sheet.getRow(currentRow)
        headerRow.height = 22
        header.forEach((text, index) => {
          const cell = headerRow.getCell(index + 1)
          cell.value = text
          cell.font = { name: 'Calibri', bold: true, size: 11 }
        })
        currentRow++

        sheet.getColumn(1).width = 28
        sheet.getColumn(2).width = 28
        sheet.getColumn(3).width = 28
        sheet.getColumn(4).width = 36
        sheet.getColumn(5).width = 28
        sheet.getColumn(6).width = 18
        sheet.getColumn(7).width = 24
        sheet.getColumn(8).width = 22

        for (let i = 4; i < rows.length; i++) {
          const [nickName, remark, groupNickname, wxid, alias] = rows[i]
          const row = sheet.getRow(currentRow)
          row.getCell(1).value = nickName
          row.getCell(2).value = remark
          row.getCell(3).value = groupNickname
          row.getCell(4).value = wxid
          row.getCell(5).value = alias
          row.alignment = { vertical: 'top', wrapText: true }
          currentRow++
        }

        await workbook.xlsx.writeFile(outputPath)
      }

      return { success: true, count: members.length }
    } catch (e) {
      return { success: false, error: String(e) }
    }
  }



}

export const groupAnalyticsService = new GroupAnalyticsService()
