// backend/server.js
const express = require('express');
const redis = require('redis');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';
const JWT_SECRET = process.env.JWT_SECRET || 'your-secret-key';
// 🔼 기본값을 100으로 상향 (환경변수로 덮어쓰기 가능)
const MAX_CONCURRENT_USERS = parseInt(process.env.MAX_CONCURRENT_USERS || '50', 10);
const SESSION_DURATION = parseInt(process.env.SESSION_DURATION || '3000', 10); // 10분

console.log('🚀 KTX Waiting Room API 서버 시작 중...');
console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
console.log(`Redis URL: ${REDIS_URL}`);
console.log(`Max Users: ${MAX_CONCURRENT_USERS}`);

const redisClient = redis.createClient({ url: REDIS_URL });
redisClient.on('error', (err) => console.error('❌ Redis 연결 에러:', err));
redisClient.on('connect', () => console.log('✅ Redis 연결 성공'));

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.path} - IP: ${req.ip}`);
  next();
});

async function initRedis() {
  try {
    await redisClient.connect();
    console.log('🔗 Redis 초기화 완료');
    await redisClient.set('stats:total_requests', '0');
    await redisClient.set('stats:successful_bookings', '0');
  } catch (error) {
    console.error('❌ Redis 초기화 실패:', error);
    process.exit(1);
  }
}

app.get('/health', async (req, res) => {
  try {
    await redisClient.ping();
    res.json({ status: 'healthy', timestamp: new Date().toISOString(), redis: 'connected', uptime: process.uptime(), version: '1.0.0' });
  } catch (error) {
    res.status(503).json({ status: 'unhealthy', error: error.message, timestamp: new Date().toISOString() });
  }
});

app.get('/', async (req, res) => {
  try {
    const stats = await getSystemStats();
    res.json({ service: '🚅 KTX Virtual Waiting Room', version: '2.0.0', status: 'running', environment: process.env.NODE_ENV || 'development', ...stats });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ===== 핵심: 대기열 자동 소진 워커가 승격을 처리하도록 설계 =====
async function tryAdmitFromQueue() {
  try {
    // 여유 슬롯이 있는 동안 대기열을 계속 승격
    while (await getCurrentActiveUsers() < MAX_CONCURRENT_USERS) {
      const nextUserStr = await redisClient.lPop('waiting_queue');
      if (!nextUserStr) break;

      const userData = JSON.parse(nextUserStr); // { userId, route, date, passengers, timestamp }
      const { userId } = userData;

      // 이미 active면 스킵(중복 방지)
      const existingSessionKeys = await redisClient.keys(`session:active:${userId}_*`);
      if (existingSessionKeys.length > 0) continue;

      const sessionId = await createActiveSession(userId);
      const token = generateAccessToken(userId, sessionId);

      // 사용자 상태 저장(클라이언트 폴링 시 바로 active로 인지 + 토큰 제공)
      await redisClient.setEx(
        `user:${userId}`,
        3600,
        JSON.stringify({
          ...userData,
          status: 'active',
          sessionId,
          token
        })
      );

      await redisClient.incr('stats:successful_bookings');
      console.log(`✅ [${new Date().toLocaleTimeString()}] 대기열 승격 → active: ${userId}`);
    }
  } catch (err) {
    console.error('대기열 승격 에러:', err);
  }
}

// 주기적 워커(200ms) - 빈 슬롯이 생기면 자동 승격
setInterval(tryAdmitFromQueue, 200);

// ====== API ======
app.post('/api/book-ktx', async (req, res) => {
  try {
    const { userId = uuidv4(), route = '서울→부산', date = '2025-02-09', passengers = 1 } = req.body;
    const timestamp = Date.now();

    await redisClient.incr('stats:total_requests');
    const activeUsers = await getCurrentActiveUsers();

    // 이미 active인 사용자가 다시 치는 경우 방지(옵션)
    const existingSessionKeys = await redisClient.keys(`session:active:${userId}_*`);
    if (existingSessionKeys.length > 0) {
      const userInfoRaw = await redisClient.get(`user:${userId}`);
      const userInfo = userInfoRaw ? JSON.parse(userInfoRaw) : {};
      return res.json({
        status: 'allowed',
        message: '이미 예매 진행 중입니다.',
        userId,
        sessionId: userInfo.sessionId,
        token: userInfo.token,
        activeUsers,
        maxUsers: MAX_CONCURRENT_USERS,
        sessionDuration: SESSION_DURATION / 1000,
        timestamp
      });
    }

    if (activeUsers < MAX_CONCURRENT_USERS) {
      // 즉시 허용 + 세션 생성
      const sessionId = await createActiveSession(userId);
      const token = generateAccessToken(userId, sessionId);

      await redisClient.incr('stats:successful_bookings');

      // 사용자 상태 저장
      await redisClient.setEx(
        `user:${userId}`,
        3600,
        JSON.stringify({
          userId, route, date, passengers, timestamp, status: 'active', sessionId, token
        })
      );

      console.log(`✅ [${new Date().toLocaleTimeString()}] 예매 허용 - ${userId} (${activeUsers + 1}/${MAX_CONCURRENT_USERS})`);

      res.json({
        status: 'allowed',
        message: '🎉 KTX 예매 페이지 진입 허용!',
        userId,
        sessionId,
        token,
        route,
        date,
        passengers,
        activeUsers: activeUsers + 1,
        maxUsers: MAX_CONCURRENT_USERS,
        sessionDuration: SESSION_DURATION / 1000,
        timestamp
      });
    } else {
      // 대기열 등록
      const queuePosition = await addToQueue(userId, { route, date, passengers });
      const estimatedWait = calculateEstimatedWait(queuePosition);

      console.log(`⏳ [${new Date().toLocaleTimeString()}] 대기열 추가 - ${userId} (${queuePosition}번째)`);

      res.json({
        status: 'queued',
        message: '🚪 대기열에 등록되었습니다',
        userId,
        queuePosition,
        estimatedWaitMinutes: estimatedWait,
        route,
        date,
        passengers,
        activeUsers,
        maxUsers: MAX_CONCURRENT_USERS,
        timestamp
      });
    }
  } catch (error) {
    console.error('예매 처리 에러:', error);
    res.status(500).json({ error: '예매 처리 중 오류가 발생했습니다', details: error.message });
  }
});

app.get('/api/queue-status', async (req, res) => {
  try {
    const stats = await getSystemStats();
    res.json({
      timestamp: new Date().toISOString(),
      ...stats,
      serverInfo: {
        maxConcurrentUsers: MAX_CONCURRENT_USERS,
        sessionDurationMinutes: SESSION_DURATION / 60000,
        version: '2.0.0',
        uptime: Math.floor(process.uptime())
      }
    });
  } catch (error) {
    console.error('상태 조회 에러:', error);
    res.status(500).json({ error: '상태 조회 중 오류가 발생했습니다' });
  }
});

app.get('/api/user-status/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const userStatus = await getUserStatus(userId);
    res.json(userStatus);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/verify-token', (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ error: 'Token required' });
    const decoded = jwt.verify(token, JWT_SECRET);
    res.json({ valid: true, userId: decoded.userId, sessionId: decoded.sessionId, expiresAt: decoded.exp });
  } catch (error) {
    res.status(401).json({ valid: false, error: 'Invalid token' });
  }
});

app.post('/api/end-session', async (req, res) => {
  try {
    const { sessionId, userId } = req.body;
    await endSession(sessionId, userId);
    res.json({ message: '세션이 종료되었습니다' });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/admin/reset', async (req, res) => {
  try {
    console.log('🔄 관리자 리셋 요청 처리 중...');

    // 기존 resetStats 함수 호출
    await resetStats();

    console.log('✅ 시스템 리셋 완료');

    res.json({
      success: true,
      message: '시스템이 성공적으로 리셋되었습니다',
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('❌ 리셋 처리 에러:', error);
    res.status(500).json({
      success: false,
      error: '리셋 처리 중 오류가 발생했습니다',
      details: error.message
    });
  }
});

// ===== 헬퍼 =====
async function getCurrentActiveUsers() {
  try {
    const activeKeys = await redisClient.keys('session:active:*');
    let activeCount = 0;
    for (const key of activeKeys) {
      const ttl = await redisClient.ttl(key);
      if (ttl > 0) activeCount++;
    }
    return activeCount;
  } catch (error) {
    console.error('활성 사용자 조회 에러:', error);
    return 0;
  }
}

async function createActiveSession(userId) {
  const sessionId = `${userId}_${Date.now()}`;
  const sessionKey = `session:active:${sessionId}`;

  await redisClient.setEx(
    sessionKey,
    SESSION_DURATION / 1000,
    JSON.stringify({ userId, sessionId, createdAt: Date.now(), status: 'active' })
  );

  // 자동 만료 → 세션 종료 + 승격 시도
  setTimeout(async () => {
    try {
      await endSession(sessionId, userId);
      console.log(`🏁 [${new Date().toLocaleTimeString()}] 세션 자동 만료 - ${userId}`);
    } catch (error) {
      console.error('세션 만료 처리 에러:', error);
    }
  }, SESSION_DURATION);

  return sessionId;
}

async function addToQueue(userId, bookingInfo) {
  const queueData = { userId, ...bookingInfo, timestamp: Date.now() };
  const position = await redisClient.rPush('waiting_queue', JSON.stringify(queueData));
  await redisClient.setEx(`user:${userId}`, 3600, JSON.stringify({ ...queueData, status: 'queued', queuePosition: position }));
  return position;
}

function calculateEstimatedWait(queuePosition) {
  const avgSessionTime = SESSION_DURATION / 60000; // 분
  const processingRate = MAX_CONCURRENT_USERS;
  return Math.ceil((queuePosition * avgSessionTime) / processingRate);
}

function generateAccessToken(userId, sessionId) {
  return jwt.sign(
    { userId, sessionId, iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + (SESSION_DURATION / 1000) },
    JWT_SECRET
  );
}

async function getSystemStats() {
  try {
    const activeUsers = await getCurrentActiveUsers();
    const queueLength = await redisClient.lLen('waiting_queue');
    const totalRequests = parseInt((await redisClient.get('stats:total_requests')) || '0', 10);
    const successfulBookings = parseInt((await redisClient.get('stats:successful_bookings')) || '0', 10);

    return {
      activeUsers,
      maxUsers: MAX_CONCURRENT_USERS,
      queueLength,
      totalRequests,
      successfulBookings,
      rejectedRequests: totalRequests - successfulBookings,
      successRate: totalRequests > 0 ? ((successfulBookings / totalRequests) * 100).toFixed(1) + '%' : '0%',
      systemStatus: activeUsers >= MAX_CONCURRENT_USERS ? 'busy' : 'available'
    };
  } catch (error) {
    console.error('통계 조회 에러:', error);
    return {
      activeUsers: 0,
      maxUsers: MAX_CONCURRENT_USERS,
      queueLength: 0,
      totalRequests: 0,
      successfulBookings: 0,
      rejectedRequests: 0,
      successRate: '0%',
      systemStatus: 'error'
    };
  }
}

async function getUserStatus(userId) {
  try {
    const userKey = `user:${userId}`;
    const userDataStr = await redisClient.get(userKey);
    const base = userDataStr ? JSON.parse(userDataStr) : null;

    // active 확인
    const sessionKeys = await redisClient.keys(`session:active:${userId}_*`);
    if (sessionKeys.length > 0) {
      return { status: 'active', message: '현재 예매 진행 중', ...(base || { userId }) };
    }

    // queue 확인
    const queueItems = await redisClient.lRange('waiting_queue', 0, -1);
    for (let i = 0; i < queueItems.length; i++) {
      const item = JSON.parse(queueItems[i]);
      if (item.userId === userId) {
        return {
          status: 'queued',
          queuePosition: i + 1,
          estimatedWait: calculateEstimatedWait(i + 1),
          ...(base || item)
        };
      }
    }

    return base ? { status: base.status || 'unknown', ...base } : { status: 'not_found', message: '사용자 정보를 찾을 수 없습니다' };
  } catch (error) {
    console.error('사용자 상태 조회 에러:', error);
    return { status: 'error', message: error.message };
  }
}

async function endSession(sessionId, userId) {
  try {
    const sessionKey = `session:active:${sessionId}`;
    await redisClient.del(sessionKey);

    // 사용자 상태도 정리(옵션)
    const userKey = `user:${userId}`;
    const userDataStr = await redisClient.get(userKey);
    if (userDataStr) {
      const u = JSON.parse(userDataStr);
      await redisClient.setEx(userKey, 3600, JSON.stringify({ ...u, status: 'ended' }));
    }

    // 슬롯 비었으니 바로 승격 시도
    await tryAdmitFromQueue();
  } catch (error) {
    console.error('세션 종료 에러:', error);
  }
}

async function resetStats() {
  try {
    await redisClient.del('stats:total_requests');
    await redisClient.del('stats:successful_bookings');
    await redisClient.del('waiting_queue');

    const sessionKeys = await redisClient.keys('session:active:*');
    if (sessionKeys.length > 0) {
      await redisClient.del(sessionKeys);
    }

    const userKeys = await redisClient.keys('user:*');
    if (userKeys.length > 0) {
      await redisClient.del(userKeys);
    }

    console.log('📊 모든 데이터가 리셋되었습니다');
  } catch (error) {
    console.error('리셋 에러:', error);
    throw error;
  }
}

process.on('SIGINT', async () => {
  console.log('\n🛑 서버 종료 중...');
  try {
    await redisClient.quit();
    console.log('✅ Redis 연결 종료');
  } catch (error) {
    console.error('Redis 종료 에러:', error);
  }
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('🛑 SIGTERM 신호 수신, 서버 종료 중...');
  try {
    await redisClient.quit();
  } catch (error) {
    console.error('Redis 종료 에러:', error);
  }
  process.exit(0);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
});

async function startServer() {
  try {
    await initRedis();
    app.listen(PORT, '0.0.0.0', () => {
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('🚅 KTX Virtual Waiting Room API Server');
      console.log(`🌐 http://0.0.0.0:${PORT}`);
      console.log(`👥 최대 동시 사용자: ${MAX_CONCURRENT_USERS}명`);
      console.log(`⏱️  세션 지속 시간: ${SESSION_DURATION / 60000}분`);
      console.log(`🔗 Redis: ${REDIS_URL}`);
      console.log(`🏷️  Environment: ${process.env.NODE_ENV || 'development'}`);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
});
  } catch (error) {
    console.error('❌ 서버 시작 실패:', error);
    process.exit(1);
  }
}
startServer();

