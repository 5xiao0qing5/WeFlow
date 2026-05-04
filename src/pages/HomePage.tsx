import { MessageSquare, BarChart3, Download, Aperture, Footprints, FolderClosed } from 'lucide-react'
import { useNavigate } from 'react-router-dom'
import './HomePage.scss'

function HomePage() {
  const navigate = useNavigate()

  const features = [
    { icon: MessageSquare, label: '聊天', desc: '浏览聊天记录', path: '/chat' },
    { icon: Aperture, label: '朋友圈', desc: '查看朋友圈动态', path: '/sns' },
    { icon: BarChart3, label: '聊天分析', desc: '分析聊天统计数据', path: '/analytics' },
    { icon: FolderClosed, label: '资源浏览', desc: '管理媒体文件', path: '/resources' },
    { icon: Footprints, label: '我的足迹', desc: '回顾你的轨迹', path: '/footprint' },
    { icon: Download, label: '导出', desc: '导出聊天记录', path: '/export' },
  ]

  return (
    <div className="home-page">
      <div className="home-content">
        <h1 className="home-title">WeFlow</h1>
        <p className="home-subtitle">每一条消息的背后，都藏着一段温暖的时光</p>

        <div className="home-grid">
          {features.map((f) => (
            <button
              key={f.path}
              className="home-feature-card"
              onClick={() => navigate(f.path)}
              type="button"
            >
              <f.icon size={20} />
              <div className="home-feature-text">
                <span className="home-feature-label">{f.label}</span>
                <span className="home-feature-desc">{f.desc}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

export default HomePage
