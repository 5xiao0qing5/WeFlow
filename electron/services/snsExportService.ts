import fs from 'fs/promises'
import path from 'path'
import ExcelJS from 'exceljs'
import { fileURLToPath } from 'url'
import { snsService, SnsPost } from './snsService'

export interface SnsExportFilters {
  usernames?: string[]
  keyword?: string
  startTime?: number
  endTime?: number
}

export interface SnsExportOptions {
  format: 'json' | 'excel' | 'txt'
  exportMedia?: boolean
}

export interface SnsExportProgress {
  current: number
  total: number
  message: string
}

export interface SnsExportResult {
  success: boolean
  outputDir?: string
  outputPath?: string
  error?: string
}

interface ExportedMediaItem {
  url: string
  thumb: string
  localPath?: string
}

interface ExportedPost extends Omit<SnsPost, 'media'> {
  media: ExportedMediaItem[]
}

const sanitizeFileName = (name: string) => name.replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').slice(0, 80)

const formatTimestamp = (timestamp: number) => {
  const date = new Date(timestamp * 1000)
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

const buildExportBaseName = () => {
  const now = new Date()
  const pad = (value: number) => String(value).padStart(2, '0')
  return `sns-export-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

const resolveMediaExtension = (url: string, fallback: string) => {
  try {
    const parsed = new URL(url)
    const ext = path.extname(parsed.pathname)
    if (ext) return ext
  } catch {
    const ext = path.extname(url)
    if (ext) return ext
  }
  return fallback
}

const downloadMediaFile = async (sourceUrl: string, targetPath: string) => {
  if (sourceUrl.startsWith('file://')) {
    const localPath = fileURLToPath(sourceUrl)
    await fs.copyFile(localPath, targetPath)
    return
  }

  const response = await fetch(sourceUrl)
  if (!response.ok) {
    throw new Error(`下载失败: ${response.status} ${response.statusText}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  await fs.writeFile(targetPath, buffer)
}

class SnsExportService {
  private async collectTimeline(filters: SnsExportFilters): Promise<SnsPost[]> {
    const timeline: SnsPost[] = []
    const limit = 200
    let offset = 0

    while (true) {
      const result = await snsService.getTimeline(limit, offset, filters.usernames, filters.keyword, filters.startTime, filters.endTime)
      if (!result.success) {
        throw new Error(result.error || '获取朋友圈失败')
      }
      if (!result.timeline || result.timeline.length === 0) {
        break
      }
      timeline.push(...result.timeline)
      if (result.timeline.length < limit) {
        break
      }
      offset += limit
    }

    return timeline
  }

  private async exportMedia(
    posts: ExportedPost[],
    exportDir: string,
    onProgress?: (progress: SnsExportProgress) => void
  ): Promise<ExportedPost[]> {
    const mediaDir = path.join(exportDir, 'media')
    await fs.mkdir(mediaDir, { recursive: true })

    const total = posts.reduce((sum, post) => sum + post.media.length, 0)
    let current = 0

    if (total === 0) {
      return posts
    }

    for (let postIndex = 0; postIndex < posts.length; postIndex += 1) {
      const post = posts[postIndex]
      const fallbackExt = post.type === 15 ? '.mp4' : '.jpg'

      for (let mediaIndex = 0; mediaIndex < post.media.length; mediaIndex += 1) {
        const media = post.media[mediaIndex]
        const sourceUrl = media.url || media.thumb
        if (!sourceUrl) {
          continue
        }

        const extension = resolveMediaExtension(sourceUrl, fallbackExt)
        const fileName = sanitizeFileName(`post-${postIndex + 1}-media-${mediaIndex + 1}${extension}`)
        const targetPath = path.join(mediaDir, fileName)

        try {
          await downloadMediaFile(sourceUrl, targetPath)
          media.localPath = path.relative(exportDir, targetPath)
        } catch (error) {
          console.warn('[SnsExportService] Failed to export media', sourceUrl, error)
        }

        current += 1
        onProgress?.({
          current,
          total,
          message: `正在导出媒体 ${current}/${total}`
        })
      }
    }

    return posts
  }

  private async exportToJson(posts: ExportedPost[], outputPath: string, filters: SnsExportFilters) {
    const payload = {
      exportedAt: Math.floor(Date.now() / 1000),
      filters,
      posts
    }
    await fs.writeFile(outputPath, JSON.stringify(payload, null, 2), 'utf8')
  }

  private async exportToTxt(posts: ExportedPost[], outputPath: string) {
    const lines: string[] = []

    posts.forEach((post, index) => {
      lines.push(`【${index + 1}】${formatTimestamp(post.createTime)} ${post.nickname} (${post.username})`)
      if (post.contentDesc) {
        lines.push(post.contentDesc)
      }
      if (post.media.length > 0) {
        const mediaList = post.media
          .map((item) => item.localPath || item.url || item.thumb)
          .filter(Boolean)
          .join(' | ')
        if (mediaList) {
          lines.push(`媒体: ${mediaList}`)
        }
      }
      if (post.likes.length > 0) {
        lines.push(`点赞: ${post.likes.join('、')}`)
      }
      if (post.comments.length > 0) {
        const commentText = post.comments
          .map((comment) => `${comment.nickname}${comment.refNickname ? ` 回复 ${comment.refNickname}` : ''}: ${comment.content}`)
          .join(' | ')
        lines.push(`评论: ${commentText}`)
      }
      lines.push('')
    })

    await fs.writeFile(outputPath, lines.join('\n'), 'utf8')
  }

  private async exportToExcel(posts: ExportedPost[], outputPath: string) {
    const workbook = new ExcelJS.Workbook()
    const worksheet = workbook.addWorksheet('朋友圈')

    worksheet.columns = [
      { header: '序号', key: 'index', width: 8 },
      { header: '时间', key: 'time', width: 22 },
      { header: '昵称', key: 'nickname', width: 18 },
      { header: '微信号', key: 'username', width: 22 },
      { header: '内容', key: 'content', width: 40 },
      { header: '媒体', key: 'media', width: 45 },
      { header: '点赞', key: 'likes', width: 30 },
      { header: '评论', key: 'comments', width: 45 }
    ]

    posts.forEach((post, index) => {
      const mediaList = post.media
        .map((item) => item.localPath || item.url || item.thumb)
        .filter(Boolean)
        .join('\n')
      const commentText = post.comments
        .map((comment) => `${comment.nickname}${comment.refNickname ? ` 回复 ${comment.refNickname}` : ''}: ${comment.content}`)
        .join('\n')

      worksheet.addRow({
        index: index + 1,
        time: formatTimestamp(post.createTime),
        nickname: post.nickname,
        username: post.username,
        content: post.contentDesc || '',
        media: mediaList,
        likes: post.likes.join('、'),
        comments: commentText
      })
    })

    worksheet.eachRow((row) => {
      row.alignment = { vertical: 'top', wrapText: true }
    })

    await workbook.xlsx.writeFile(outputPath)
  }

  async exportTimeline(
    outputDir: string,
    filters: SnsExportFilters,
    options: SnsExportOptions,
    onProgress?: (progress: SnsExportProgress) => void
  ): Promise<SnsExportResult> {
    try {
      if (!outputDir) {
        return { success: false, error: '导出路径未设置' }
      }

      const timeline = await this.collectTimeline(filters)
      const exportDirName = buildExportBaseName()
      const exportDir = path.join(outputDir, exportDirName)
      await fs.mkdir(exportDir, { recursive: true })

      const ext = options.format === 'excel' ? 'xlsx' : options.format
      const outputPath = path.join(exportDir, `${exportDirName}.${ext}`)

      const exportedPosts: ExportedPost[] = timeline.map((post) => ({
        ...post,
        media: (post.media || []).map((media) => ({
          url: media.url,
          thumb: media.thumb
        }))
      }))

      if (options.exportMedia) {
        onProgress?.({ current: 0, total: Math.max(1, exportedPosts.reduce((sum, post) => sum + post.media.length, 0)), message: '准备导出媒体...' })
        await this.exportMedia(exportedPosts, exportDir, onProgress)
      }

      onProgress?.({ current: 0, total: Math.max(1, exportedPosts.length), message: '正在写入导出文件...' })

      if (options.format === 'json') {
        await this.exportToJson(exportedPosts, outputPath, filters)
      } else if (options.format === 'txt') {
        await this.exportToTxt(exportedPosts, outputPath)
      } else {
        await this.exportToExcel(exportedPosts, outputPath)
      }

      onProgress?.({ current: exportedPosts.length, total: Math.max(1, exportedPosts.length), message: '导出完成' })

      return { success: true, outputDir: exportDir, outputPath }
    } catch (error) {
      console.error('[SnsExportService] exportTimeline failed', error)
      return { success: false, error: String(error) }
    }
  }
}

export const snsExportService = new SnsExportService()
