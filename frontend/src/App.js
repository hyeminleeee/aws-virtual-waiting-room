// frontend/src/App.js
import React, { useState, useEffect } from 'react';
import './App.css';

const API_BASE_URL = window.location.hostname === 'localhost' 
  ? 'http://localhost:3000/api' 
  : '/api';

function App() {
  const [status, setStatus] = useState('idle');
  const [queueData, setQueueData] = useState(null);
  const [systemStats, setSystemStats] = useState(null);
  const [userId, setUserId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [bookingForm, setBookingForm] = useState({
    route: '서울 → 부산',
    date: '2025-02-09',
    passengers: 1
  });

  // 시스템 상태 주기적 업데이트
  useEffect(() => {
    fetchSystemStats();
    const interval = setInterval(fetchSystemStats, 3000);
    return () => clearInterval(interval);
  }, []);

  // 사용자 상태 주기적 확인 (대기열 사용자만)
  useEffect(() => {
    if (userId && status === 'queued') {
      const interval = setInterval(() => fetchUserStatus(userId), 5000);
      return () => clearInterval(interval);
    }
  }, [userId, status]);

  const fetchSystemStats = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/queue-status`);
      const data = await response.json();
      setSystemStats(data);
    } catch (error) {
      console.error('시스템 상태 조회 실패:', error);
    }
  };

  const fetchUserStatus = async (userId) => {
    try {
      const response = await fetch(`${API_BASE_URL}/user-status/${userId}`);
      const data = await response.json();
      
      if (data.status === 'active') {
        setStatus('allowed');
        setQueueData(data);
      } else if (data.status === 'queued') {
        setQueueData(data);
      }
    } catch (error) {
      console.error('사용자 상태 조회 실패:', error);
    }
  };

  const handleBookKTX = async () => {
    setLoading(true);
    try {
      const response = await fetch(`${API_BASE_URL}/book-ktx`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(bookingForm)
      });

      const data = await response.json();
      
      if (data.status === 'allowed') {
        setStatus('allowed');
        setUserId(data.userId);
        setQueueData(data);
        if (data.token) {
          localStorage.setItem('ktx-token', data.token);
        }
      } else if (data.status === 'queued') {
        setStatus('queued');
        setUserId(data.userId);
        setQueueData(data);
      }
    } catch (error) {
      console.error('예매 요청 실패:', error);
      alert('예매 요청 중 오류가 발생했습니다.');
    } finally {
      setLoading(false);
    }
  };

  const handleReset = async () => {
    try {
      await fetch(`${API_BASE_URL}/admin/reset`, { method: 'POST' });
      setStatus('idle');
      setQueueData(null);
      setUserId(null);
      localStorage.removeItem('ktx-token');
      alert('시스템이 리셋되었습니다.');
    } catch (error) {
      console.error('리셋 실패:', error);
    }
  };

  const formatTime = (timestamp) => {
    return new Date(timestamp).toLocaleTimeString('ko-KR');
  };

  const handleInputChange = (field, value) => {
    setBookingForm(prev => ({
      ...prev,
      [field]: value
    }));
  };

  return (
    <div className="App">
      <div className="container">
        {/* 헤더 */}
        <header className="header">
          <h1 className="title">🚅 KTX 설날 예매 시스템</h1>
          <p className="subtitle">Virtual Waiting Room Demo</p>
        </header>

        {/* 시스템 상태 카드 */}
        {systemStats && (
          <div className="status-card">
            <h2 className="status-title">
              📊 실시간 시스템 현황
              <span className={`status-badge ${systemStats.systemStatus}`}>
                {systemStats.systemStatus === 'available' ? '여유' : '혼잡'}
              </span>
            </h2>
            
            <div className="metrics-grid">
              <div className="metric">
                <div className="metric-number">{systemStats.activeUsers}</div>
                <div className="metric-label">현재 예매 중</div>
                <div className="metric-sub">최대 {systemStats.maxUsers}명</div>
              </div>
              
              <div className="metric">
                <div className="metric-number">{systemStats.queueLength}</div>
                <div className="metric-label">대기 중</div>
              </div>
              
              <div className="metric">
                <div className="metric-number">{systemStats.totalRequests}</div>
                <div className="metric-label">총 요청</div>
              </div>
              
              <div className="metric">
                <div className="metric-number">{systemStats.successRate}</div>
                <div className="metric-label">성공률</div>
              </div>
            </div>
          </div>
        )}

        {/* 메인 콘텐츠 */}
        <div className="main-card">
          {status === 'idle' && (
            <div className="booking-form">
              <div className="form-header">
                <div className="icon">🎫</div>
                <h2>KTX 설날 승차권 예매</h2>
              </div>
              
              <div className="form-group">
                <label>노선</label>
                <select 
                  value={bookingForm.route}
                  onChange={(e) => handleInputChange('route', e.target.value)}
                >
                  <option value="서울 → 부산">서울 → 부산</option>
                  <option value="서울 → 대구">서울 → 대구</option>
                  <option value="서울 → 광주">서울 → 광주</option>
                  <option value="부산 → 서울">부산 → 서울</option>
                </select>
              </div>

              <div className="form-group">
                <label>날짜</label>
                <input 
                  type="date" 
                  value={bookingForm.date}
                  onChange={(e) => handleInputChange('date', e.target.value)}
                />
              </div>

              <div className="form-group">
                <label>인원</label>
                <select 
                  value={bookingForm.passengers}
                  onChange={(e) => handleInputChange('passengers', parseInt(e.target.value))}
                >
                  <option value={1}>1명</option>
                  <option value={2}>2명</option>
                  <option value={3}>3명</option>
                  <option value={4}>4명</option>
                </select>
              </div>
              
              <button
                onClick={handleBookKTX}
                disabled={loading}
                className={`booking-btn ${loading ? 'loading' : ''}`}
              >
                {loading ? '처리 중...' : '🚅 예매하기'}
              </button>
            </div>
          )}

          {status === 'queued' && queueData && (
            <div className="queue-status">
              <div className="icon">⏳</div>
              <h2>대기열에 등록되었습니다</h2>
              
              <div className="queue-info">
                <div className="queue-position">
                  {queueData.queuePosition}번째
                </div>
                <div className="wait-time">
                  예상 대기시간: 약 {queueData.estimatedWaitMinutes || queueData.estimatedWait}분
                </div>
              </div>

              <div className="booking-details">
                <h3>예매 정보</h3>
                <p>노선: {queueData.route}</p>
                <p>날짜: {queueData.date}</p>
                <p>인원: {queueData.passengers}명</p>
              </div>
              
              <div className="queue-tips">
                <p>💡 창을 닫지 마세요. 순서가 되면 자동으로 안내됩니다.</p>
                <p>📱 다른 기기에서 중복 접속 시 대기번호가 무효화될 수 있습니다.</p>
                <p>⏰ 등록 시간: {formatTime(queueData.timestamp)}</p>
              </div>
            </div>
          )}

          {status === 'allowed' && queueData && (
            <div className="success-status">
              <div className="icon">🎉</div>
              <h2>예매 페이지 진입 허용!</h2>
              
              <div className="success-info">
                <div className="success-message">✅ 예매를 진행하세요</div>
                <div className="session-info">
                  <p>🕐 세션 유지 시간: {Math.floor(queueData.sessionDuration / 60)}분</p>
                  <p>👤 사용자 ID: {queueData.userId}</p>
                  <p>🎫 예매 정보: {queueData.route} ({queueData.date})</p>
                </div>
              </div>
              
              <div className="action-buttons">
                <button className="continue-btn">
                  🚅 예매 계속하기
                </button>
                <button 
                  onClick={() => {
                    setStatus('idle');
                    setQueueData(null);
                    setUserId(null);
                  }}
                  className="later-btn"
                >
                  나중에 하기
                </button>
              </div>
            </div>
          )}
        </div>

        {/* 관리자 도구 */}
        <div className="admin-section">
          <button onClick={handleReset} className="reset-btn">
            🔄 시스템 리셋 (관리자)
          </button>
        </div>

        {/* 실시간 로그 */}
        {systemStats && (
          <div className="log-section">
            <div className="log-title">🖥️ 실시간 시스템 로그</div>
            <div className="log-content">
              <div>[{formatTime(Date.now())}] 활성 사용자: {systemStats.activeUsers}/{systemStats.maxUsers}</div>
              <div>[{formatTime(Date.now())}] 대기열 길이: {systemStats.queueLength}명</div>
              <div>[{formatTime(Date.now())}] 총 요청: {systemStats.totalRequests}건 (성공률: {systemStats.successRate})</div>
              {systemStats.serverInfo && (
                <div>[{formatTime(Date.now())}] 서버 업타임: {systemStats.serverInfo.uptime}초</div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export default App;
