import { useEffect, useState, useRef, useCallback } from 'react'
import { RefreshCw, Heart, Search, Calendar, User, X, Filter, Download, FileJson, FileSpreadsheet, FileText, Loader2, FolderOpen } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import { ImagePreview } from '../components/ImagePreview'
import * as configService from '../services/config'
import './SnsPage.scss'

interface SnsPost {
    id: string
    username: string
    nickname: string
    avatarUrl?: string
    createTime: number
    contentDesc: string
    type?: number
    media: { url: string; thumb: string }[]
    likes: string[]
    comments: { id: string; nickname: string; content: string; refCommentId: string; refNickname?: string }[]
}

const MediaItem = ({ url, thumb, onPreview }: { url: string, thumb: string, onPreview: () => void }) => {
    const [error, setError] = useState(false);

    if (error) {
        return (
            <div className="media-item error">
                <span>无法加载</span>
            </div>
        );
    }

    return (
        <div className="media-item">
            <img
                src={thumb || url}
                alt=""
                loading="lazy"
                onClick={onPreview}
                onError={() => setError(true)}
            />
        </div>
    );
};

interface Contact {
    username: string
    displayName: string
    avatarUrl?: string
}

export default function SnsPage() {
    const [posts, setPosts] = useState<SnsPost[]>([])
    const [loading, setLoading] = useState(false)
    const [offset, setOffset] = useState(0)
    const [hasMore, setHasMore] = useState(true)
    const loadingRef = useRef(false)

    // 筛选与搜索状态
    const [searchKeyword, setSearchKeyword] = useState('')
    const [selectedUsernames, setSelectedUsernames] = useState<string[]>([])
    const [startDate, setStartDate] = useState('')
    const [endDate, setEndDate] = useState('')
    const [isSidebarOpen, setIsSidebarOpen] = useState(true)

    // 联系人列表状态
    const [contacts, setContacts] = useState<Contact[]>([])
    const [contactSearch, setContactSearch] = useState('')
    const [contactsLoading, setContactsLoading] = useState(false)
    const [previewImage, setPreviewImage] = useState<string | null>(null)
    const [showExportModal, setShowExportModal] = useState(false)
    const [exportFormat, setExportFormat] = useState<'json' | 'excel' | 'txt'>('excel')
    const [exportMedia, setExportMedia] = useState(true)
    const [exportFolder, setExportFolder] = useState('')
    const [isExporting, setIsExporting] = useState(false)
    const [exportProgress, setExportProgress] = useState({ current: 0, total: 0, message: '' })
    const [exportResult, setExportResult] = useState<{ success: boolean; outputDir?: string; outputPath?: string; error?: string } | null>(null)

    const loadPosts = useCallback(async (reset = false) => {
        if (loadingRef.current) return
        loadingRef.current = true
        setLoading(true)

        try {
            const currentOffset = reset ? 0 : offset
            const limit = 20

            // 转换日期为秒级时间戳
            const startTs = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : undefined
            const endTs = endDate ? Math.floor(new Date(endDate).getTime() / 1000) + 86399 : undefined // 包含当天

            const result = await window.electronAPI.sns.getTimeline(
                limit,
                currentOffset,
                selectedUsernames,
                searchKeyword,
                startTs,
                endTs
            )

            if (result.success && result.timeline) {
                if (reset) {
                    setPosts(result.timeline)
                    setOffset(limit)
                    setHasMore(result.timeline.length >= limit)
                } else {
                    setPosts(prev => [...prev, ...result.timeline!])
                    setOffset(prev => prev + limit)
                    if (result.timeline.length < limit) {
                        setHasMore(false)
                    }
                }
            }
        } catch (error) {
            console.error('Failed to load SNS timeline:', error)
        } finally {
            setLoading(false)
            loadingRef.current = false
        }
    }, [offset, selectedUsernames, searchKeyword, startDate, endDate])

    // 获取联系人列表
    const loadContacts = async () => {
        setContactsLoading(true)
        try {
            const result = await window.electronAPI.chat.getSessions()
            if (result.success && result.sessions) {
                // 系统账号和特殊前缀
                const systemAccounts = ['filehelper', 'fmessage', 'newsapp', 'weixin', 'qqmail', 'tmessage', 'floatbottle', 'medianote', 'brandsessionholder'];

                // 初步提取并过滤联系人
                const initialContacts = result.sessions
                    .filter((s: any) => {
                        if (!s.username) return false;
                        const u = s.username.toLowerCase();

                        // 1. 排除群聊 (WeChat 群组以 @chatroom 结尾)
                        if (u.includes('@chatroom') || u.endsWith('@chatroom') || u.endsWith('@openim')) {
                            return false;
                        }

                        // 2. 排除公众号 (通常以 gh_ 开头)
                        if (u.startsWith('gh_')) {
                            return false;
                        }

                        // 3. 排除系统账号
                        if (systemAccounts.includes(u) || u.includes('helper') || u.includes('sessionholder')) {
                            return false;
                        }

                        return true;
                    })
                    .map((s: any) => ({
                        username: s.username,
                        displayName: s.displayName || s.username,
                        avatarUrl: s.avatarUrl
                    }))
                setContacts(initialContacts)

                // 异步进一步富化（获取更多准确的昵称和头像）
                const usernames = initialContacts.map(c => c.username)
                const enriched = await window.electronAPI.chat.enrichSessionsContactInfo(usernames)
                if (enriched.success && enriched.contacts) {
                    setContacts(prev => prev.map(c => {
                        const extra = enriched.contacts![c.username]
                        if (extra) {
                            return {
                                ...c,
                                displayName: extra.displayName || c.displayName,
                                avatarUrl: extra.avatarUrl || c.avatarUrl
                            }
                        }
                        return c
                    }))
                }
            }
        } catch (error) {
            console.error('Failed to load contacts:', error)
        } finally {
            setContactsLoading(false)
        }
    }

    useEffect(() => {
        loadContacts()
    }, [])

    useEffect(() => {
        loadPosts(true)
    }, [selectedUsernames, searchKeyword, startDate, endDate])

    useEffect(() => {
        const loadExportDefaults = async () => {
            try {
                const [savedFormat, savedMedia, savedPath] = await Promise.all([
                    configService.getExportDefaultFormat(),
                    configService.getExportDefaultMedia(),
                    configService.getExportPath()
                ])
                const formatValue = savedFormat === 'json' || savedFormat === 'excel' || savedFormat === 'txt'
                    ? savedFormat
                    : 'excel'
                setExportFormat(formatValue)
                setExportMedia(savedMedia ?? true)
                if (savedPath) {
                    setExportFolder(savedPath)
                } else {
                    const downloadsPath = await window.electronAPI.app.getDownloadsPath()
                    setExportFolder(downloadsPath)
                }
            } catch (error) {
                console.error('Failed to load export defaults:', error)
            }
        }
        loadExportDefaults()
    }, [])

    useEffect(() => {
        const removeListener = window.electronAPI.sns.onExportProgress?.((payload) => {
            setExportProgress(payload)
        })
        return () => {
            removeListener?.()
        }
    }, [])

    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const { scrollTop, clientHeight, scrollHeight } = e.currentTarget
        if (scrollHeight - scrollTop - clientHeight < 200 && hasMore && !loading) {
            loadPosts()
        }
    }

    const formatTime = (ts: number) => {
        const date = new Date(ts * 1000)
        const isCurrentYear = date.getFullYear() === new Date().getFullYear()

        return date.toLocaleString('zh-CN', {
            year: isCurrentYear ? undefined : 'numeric',
            month: 'short',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit'
        })
    }

    const toggleUserSelection = (username: string) => {
        setSelectedUsernames(prev => {
            if (prev.includes(username)) {
                return prev.filter(u => u !== username)
            } else {
                return [...prev, username]
            }
        })
    }

    const clearFilters = () => {
        setSearchKeyword('')
        setSelectedUsernames([])
        setStartDate('')
        setEndDate('')
    }

    const handleExport = async () => {
        if (!exportFolder) {
            setExportResult({ success: false, error: '未设置导出路径' })
            return
        }

        const startTs = startDate ? Math.floor(new Date(startDate).getTime() / 1000) : undefined
        const endTs = endDate ? Math.floor(new Date(endDate).getTime() / 1000) + 86399 : undefined

        setShowExportModal(false)
        setIsExporting(true)
        setExportProgress({ current: 0, total: 0, message: '准备导出...' })
        setExportResult(null)

        try {
            const result = await window.electronAPI.sns.exportTimeline(
                exportFolder,
                {
                    usernames: selectedUsernames,
                    keyword: searchKeyword,
                    startTime: startTs,
                    endTime: endTs
                },
                {
                    format: exportFormat,
                    exportMedia
                }
            )
            setExportResult(result)
        } catch (error) {
            setExportResult({ success: false, error: String(error) })
        } finally {
            setIsExporting(false)
        }
    }

    const exportFormatOptions = [
        { value: 'json' as const, label: 'JSON', icon: <FileJson size={16} /> },
        { value: 'excel' as const, label: 'Excel', icon: <FileSpreadsheet size={16} /> },
        { value: 'txt' as const, label: 'TXT', icon: <FileText size={16} /> }
    ]

    const filteredContacts = contacts.filter(c =>
        c.displayName.toLowerCase().includes(contactSearch.toLowerCase()) ||
        c.username.toLowerCase().includes(contactSearch.toLowerCase())
    )

    return (
        <div className="sns-page">
            <div className="sns-container">
                {/* 侧边栏：过滤与搜索 */}
                <aside className={`sns-sidebar ${isSidebarOpen ? 'open' : 'closed'}`}>
                    <div className="sidebar-header">
                        <h3>朋友圈筛选</h3>
                        <button className="toggle-btn" onClick={() => setIsSidebarOpen(false)}>
                            <X size={18} />
                        </button>
                    </div>

                    <div className="filter-content">
                        {/* 关键词与时间 */}
                        <div className="filter-group">
                            <div className="filter-section">
                                <label><Search size={14} /> 关键词内容</label>
                                <input
                                    type="text"
                                    placeholder="搜索正文..."
                                    value={searchKeyword}
                                    onChange={e => setSearchKeyword(e.target.value)}
                                />
                            </div>

                            <div className="filter-section">
                                <label><Calendar size={14} /> 时间范围</label>
                                <div className="date-inputs">
                                    <input
                                        type="date"
                                        value={startDate}
                                        onChange={e => setStartDate(e.target.value)}
                                    />
                                    <span>至</span>
                                    <input
                                        type="date"
                                        value={endDate}
                                        onChange={e => setEndDate(e.target.value)}
                                    />
                                </div>
                            </div>
                        </div>

                        {/* 联系人列表 */}
                        <div className="contact-filter-section">
                            <div className="section-header">
                                <label><User size={14} /> 联系人筛选</label>
                                {selectedUsernames.length > 0 && (
                                    <span className="selected-count">已选 {selectedUsernames.length}</span>
                                )}
                            </div>
                            <div className="contact-search">
                                <Search size={12} className="search-icon" />
                                <input
                                    type="text"
                                    placeholder="搜索好友..."
                                    value={contactSearch}
                                    onChange={e => setContactSearch(e.target.value)}
                                />
                            </div>
                            <div className="contact-list custom-scrollbar">
                                {filteredContacts.map(contact => (
                                    <div
                                        key={contact.username}
                                        className={`contact-item ${selectedUsernames.includes(contact.username) ? 'active' : ''}`}
                                        onClick={() => toggleUserSelection(contact.username)}
                                    >
                                        <Avatar src={contact.avatarUrl} name={contact.displayName} size={28} shape="rounded" />
                                        <span className="contact-name">{contact.displayName}</span>
                                        {selectedUsernames.includes(contact.username) && (
                                            <div className="check-mark">✓</div>
                                        )}
                                    </div>
                                ))}
                                {contacts.length === 0 && !contactsLoading && (
                                    <div className="empty-contacts">无可显示联系人</div>
                                )}
                            </div>
                        </div>
                    </div>

                    <div className="sidebar-footer">
                        <button className="clear-btn" onClick={clearFilters}>清除全部筛选</button>
                    </div>
                </aside>

                <main className="sns-main">
                    <div className="sns-header">
                        <div className="header-left">
                            {!isSidebarOpen && (
                                <button className="icon-btn" onClick={() => setIsSidebarOpen(true)}>
                                    <Filter size={20} />
                                </button>
                            )}
                            <h2>朋友圈</h2>
                        </div>
                        <div className="header-right">
                            <button className="icon-btn" onClick={() => setShowExportModal(true)}>
                                <Download size={18} />
                            </button>
                            <button onClick={() => loadPosts(true)} disabled={loading} className="icon-btn refresh-btn">
                                <RefreshCw size={18} className={loading ? 'spinning' : ''} />
                            </button>
                        </div>
                    </div>

                    <div className="sns-content" onScroll={handleScroll}>
                        {selectedUsernames.length > 0 && (
                            <div className="active-filters">
                                <span>筛选中: {selectedUsernames.length} 位好友</span>
                                <button onClick={() => setSelectedUsernames([])} className="clear-chip-btn">清除</button>
                            </div>
                        )}

                        {posts.map(post => (
                            <div key={post.id} className="sns-post">
                                <div className="post-header">
                                    <Avatar
                                        src={post.avatarUrl}
                                        name={post.nickname}
                                        size={44}
                                        shape="rounded"
                                    />
                                    <div className="post-info">
                                        <div className="nickname">{post.nickname}</div>
                                        <div className="time">{formatTime(post.createTime)}</div>
                                    </div>
                                </div>

                                <div className="post-body">
                                    {post.contentDesc && <div className="post-text">{post.contentDesc}</div>}

                                    {post.type === 15 ? (
                                        <div className="post-video-placeholder">
                                            [视频]
                                        </div>
                                    ) : post.media.length > 0 && (
                                        <div className={`post-media-grid media-count-${Math.min(post.media.length, 9)}`}>
                                            {post.media.map((m, idx) => (
                                                <MediaItem key={idx} url={m.url} thumb={m.thumb} onPreview={() => setPreviewImage(m.url)} />
                                            ))}
                                        </div>
                                    )}
                                </div>

                                {(post.likes.length > 0 || post.comments.length > 0) && (
                                    <div className="post-footer">
                                        {post.likes.length > 0 && (
                                            <div className="likes-section">
                                                <Heart size={14} className="icon" />
                                                <span className="likes-list">
                                                    {post.likes.join('、')}
                                                </span>
                                            </div>
                                        )}

                                        {post.comments.length > 0 && (
                                            <div className="comments-section">
                                                {post.comments.map((c, idx) => (
                                                    <div key={idx} className="comment-item">
                                                        <span className="comment-user">{c.nickname}</span>
                                                        {c.refNickname && (
                                                            <>
                                                                <span className="reply-text">回复</span>
                                                                <span className="comment-user">{c.refNickname}</span>
                                                            </>
                                                        )}
                                                        <span className="comment-separator">: </span>
                                                        <span className="comment-content">{c.content}</span>
                                                    </div>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        ))}

                        {loading && <div className="loading-more">加载中...</div>}
                        {!hasMore && posts.length > 0 && <div className="no-more">没有更多了</div>}
                        {!loading && posts.length === 0 && (
                            <div className="no-results">
                                <p>没有找到符合条件的朋友圈</p>
                                {selectedUsernames.length > 0 && (
                                    <button onClick={() => setSelectedUsernames([])} className="reset-inline">
                                        清除人员筛选
                                    </button>
                                )}
                            </div>
                        )}
                    </div>
                </main>
            </div>
            {previewImage && (
                <ImagePreview src={previewImage} onClose={() => setPreviewImage(null)} />
            )}
            {showExportModal && (
                <div className="sns-export-overlay" onClick={() => setShowExportModal(false)}>
                    <div className="sns-export-modal" onClick={e => e.stopPropagation()}>
                        <div className="modal-header">
                            <h3>导出朋友圈</h3>
                            <button className="icon-btn" onClick={() => setShowExportModal(false)}>
                                <X size={18} />
                            </button>
                        </div>

                        <div className="modal-section">
                            <label>导出格式</label>
                            <div className="format-options">
                                {exportFormatOptions.map(option => (
                                    <button
                                        key={option.value}
                                        className={`format-btn ${exportFormat === option.value ? 'active' : ''}`}
                                        onClick={() => setExportFormat(option.value)}
                                    >
                                        {option.icon}
                                        <span>{option.label}</span>
                                    </button>
                                ))}
                            </div>
                        </div>

                        <div className="modal-section">
                            <label>媒体导出</label>
                            <div className="toggle-row">
                                <span>{exportMedia ? '已开启' : '已关闭'}</span>
                                <label className="switch" htmlFor="sns-export-media">
                                    <input
                                        id="sns-export-media"
                                        type="checkbox"
                                        checked={exportMedia}
                                        onChange={e => setExportMedia(e.target.checked)}
                                    />
                                    <span className="slider" />
                                </label>
                            </div>
                        </div>

                        <div className="modal-section">
                            <label>导出路径</label>
                            <div className="path-row">
                                <span className="path-value">{exportFolder || '未设置'}</span>
                                {exportFolder && (
                                    <button className="path-action" onClick={() => window.electronAPI.shell.openPath(exportFolder)}>
                                        <FolderOpen size={16} />
                                        打开
                                    </button>
                                )}
                            </div>
                        </div>

                        <div className="modal-section">
                            <label>当前筛选</label>
                            <div className="filter-summary">
                                <span>{selectedUsernames.length > 0 ? `好友 ${selectedUsernames.length} 位` : '全部好友'}</span>
                                <span>{searchKeyword ? `关键词 “${searchKeyword}”` : '无关键词'}</span>
                                <span>{startDate || endDate ? `${startDate || '不限'} ~ ${endDate || '不限'}` : '不限时间'}</span>
                            </div>
                        </div>

                        <div className="modal-actions">
                            <button className="btn-secondary" onClick={() => setShowExportModal(false)}>取消</button>
                            <button className="btn-primary" onClick={handleExport} disabled={isExporting}>
                                {isExporting ? '导出中...' : '开始导出'}
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {isExporting && (
                <div className="sns-export-overlay">
                    <div className="sns-export-progress">
                        <Loader2 className="spinner" size={28} />
                        <p>{exportProgress.message || '正在导出...'}</p>
                        {exportProgress.total > 0 && (
                            <div className="progress-bar">
                                <div
                                    className="progress-fill"
                                    style={{ width: `${Math.min((exportProgress.current / exportProgress.total) * 100, 100)}%` }}
                                />
                            </div>
                        )}
                        {exportProgress.total > 0 && (
                            <div className="progress-text">{exportProgress.current} / {exportProgress.total}</div>
                        )}
                    </div>
                </div>
            )}
            {exportResult && (
                <div className="sns-export-overlay" onClick={() => setExportResult(null)}>
                    <div className="sns-export-result" onClick={e => e.stopPropagation()}>
                        <div className={`result-status ${exportResult.success ? 'success' : 'error'}`}>
                            {exportResult.success ? '导出完成' : '导出失败'}
                        </div>
                        {exportResult.success ? (
                            <p>文件已保存至：{exportResult.outputPath}</p>
                        ) : (
                            <p>{exportResult.error || '导出失败'}</p>
                        )}
                        <div className="modal-actions">
                            {exportResult.success && exportResult.outputDir && (
                                <button className="btn-secondary" onClick={() => window.electronAPI.shell.openPath(exportResult.outputDir)}>
                                    打开文件夹
                                </button>
                            )}
                            <button className="btn-primary" onClick={() => setExportResult(null)}>知道了</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
