import { ArrowRight, MessageSquare, Users } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import './ChatAnalyticsHubPage.scss'

function ChatAnalyticsHubPage() {
  const navigate = useNavigate()

  return (
    <div className="analytics-hub">
      <div className="analytics-hub-inner">
        <h1 className="analytics-hub-title">聊天分析</h1>
        <p className="analytics-hub-desc">
          选择你要进入的分析视角。私聊分析适合查看好友聊天统计，群聊分析则用于查看群成员活跃度。
        </p>

        <div className="analytics-hub-grid">
          <button
            type="button"
            className="analytics-hub-card"
            onClick={() => navigate('/analytics/private')}
          >
            <div className="analytics-hub-card-icon">
              <MessageSquare size={22} />
            </div>
            <div className="analytics-hub-card-body">
              <div className="analytics-hub-card-header">
                <h2>私聊分析</h2>
                <ArrowRight size={16} className="analytics-hub-card-arrow" />
              </div>
              <p>查看好友聊天统计、消息趋势、活跃时段与联系人排名。</p>
            </div>
          </button>

          <button
            type="button"
            className="analytics-hub-card"
            onClick={() => navigate('/analytics/group')}
          >
            <div className="analytics-hub-card-icon analytics-hub-card-icon--group">
              <Users size={22} />
            </div>
            <div className="analytics-hub-card-body">
              <div className="analytics-hub-card-header">
                <h2>群聊分析</h2>
                <ArrowRight size={16} className="analytics-hub-card-arrow" />
              </div>
              <p>查看群成员信息、发言排行、活跃时段和媒体内容统计。</p>
            </div>
          </button>
        </div>
      </div>
    </div>
  )
}

export default ChatAnalyticsHubPage
