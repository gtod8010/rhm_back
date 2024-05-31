const express = require('express');
const { Pool } = require('pg');
const app = express();
const port = 8006;
const cors = require('cors');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const cron = require('node-cron');

app.use(cors());

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SECRET_KEY = 'your_secret_key'; 

// PostgreSQL 연결 설정
const pool = new Pool({
  user: 'dwight',
  host: 'localhost',
  database: 'ywdbadmin',
  password: 'aabc1234',
  port: 5432,
});

const corsOptions = {
  origin: ['http://rhm.co.kr', 'http://www.rhm.co.kr', 'http://localhost:3000'],
  optionsSuccessStatus: 200
};

app.use(cors(corsOptions));

// 기본 경로
app.get('/', (req, res) => {
  res.send('Hello World!');
});

app.post('/api/getRewards', async (req, res) => {
  const { username } = req.body;
  try {
    const userResult = await pool.query('SELECT id, role FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(400).json({ message: 'User not found' });
    }

    const user = userResult.rows[0];
    let data;
    
    if (user.role === 'admin') {
      // admin인 경우 admin_id가 같은 모든 reward를 반환
      data = await pool.query('SELECT * FROM data WHERE admin_id = $1', [user.id]);
    } else if (user.role === 'user') {
      // user인 경우 자신이 등록한 reward만 반환
      data = await pool.query('SELECT * FROM data WHERE id = $1', [username]);
    } else {
      return res.status(400).json({ message: 'Invalid user role' });
    }

    res.json(data.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/addReward', async (req, res) => {
  const { username, company_name, setting_keyword, final_keyword, place_code, work_volume, start_date, end_date } = req.body;
  console.log(username, company_name, setting_keyword, final_keyword, place_code, work_volume, start_date, end_date)
  if (!username || !company_name || !setting_keyword || !final_keyword || !place_code || !work_volume || !start_date || !end_date) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const userResult = await pool.query('SELECT id, admin_id FROM users WHERE username = $1', [username]);
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: 'User not found' });
    }
    const user = userResult.rows[0];

    const idxResult = await pool.query('SELECT COALESCE(MAX(idx)::int, 0) + 1 AS idx FROM data');
    const rewardNoResult = await pool.query('SELECT COALESCE(MAX(reward_no)::int, 0) + 1 AS reward_no FROM data');
    const idx = idxResult.rows[0].idx;
    const rewardNo = rewardNoResult.rows[0].reward_no;

    const insertResult = await pool.query(
      `INSERT INTO data (
        idx, id, reward_no, reward_type, used, status, company_name, place_code,
        setting_keyword, final_keyword, start_date, end_date, work_volume, admin_id
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
      ) RETURNING *`,
      [
        idx, username, rewardNo, '플레이스(저장)', false, '비활성화', company_name, place_code,
        setting_keyword, final_keyword, new Date(start_date), new Date(end_date), work_volume, user.admin_id
      ]
    );

    const newReward = insertResult.rows[0];
    res.status(201).json(newReward);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/extendReward', async (req, res) => {
  const { idx, end_date } = req.body;
  console.log(idx, end_date)
  if (!idx || !end_date) {
    return res.status(400).json({ message: 'IDX and end_date are required' });
  }

  try {
    const query = 'UPDATE data SET end_date = $2 WHERE idx = $1 RETURNING *';
    const values = [idx, new Date(end_date)];
    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Reward not found' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error extending reward:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/extendMultipleRewards', async (req, res) => {
  const { rewards } = req.body;

  try {
    const updatedRewards = await Promise.all(
      rewards.map(async (reward) => {
        const { idx, end_date } = reward;
        const result = await pool.query(
          'UPDATE data SET end_date = $1 WHERE idx = $2 RETURNING *',
          [end_date, idx]
        );
        return result.rows[0];
      })
    );

    res.json(updatedRewards);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/editReward', async (req, res) => {
  const { idx, company_name, setting_keyword, final_keyword, place_code, work_volume } = req.body;

  if (!idx || !company_name || !setting_keyword || !final_keyword || !place_code || !work_volume) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const result = await pool.query(
      `UPDATE data 
       SET company_name = $1, setting_keyword = $2, final_keyword = $3, place_code = $4, work_volume = $5
       WHERE idx = $6
       RETURNING *`,
      [company_name, setting_keyword, final_keyword, place_code, work_volume, idx]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ message: 'Reward not found' });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Error editing reward:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/deleteRewards', async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'No IDs provided' });
  }

  try {
    const deleteQuery = `DELETE FROM data WHERE idx = ANY($1::int[])`;
    await pool.query(deleteQuery, [ids]);
    res.status(200).json({ message: 'Rewards deleted successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});


app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await pool.query('SELECT * FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0) {
      console.error(`Invalid credentials: No user found with username ${username}`);
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const hashedPassword = user.rows[0].password;
    console.log(`Database hashed password: ${hashedPassword}`);
    console.log(`Provided password: ${password}`);

    const validPassword = await bcrypt.compare(password, hashedPassword);
    console.log(`Password match: ${validPassword}`);

    if (!validPassword) {
      console.error('Invalid credentials: Password does not match');
      return res.status(400).json({ message: 'Invalid credentials' });
    }

    const token = jwt.sign({ id: user.rows[0].id, role: user.rows[0].role }, SECRET_KEY, { expiresIn: '1h' });

    // 사용자 정보 반환
    let userInfo = { username: user.rows[0].username, role: user.rows[0].role };
    if (user.rows[0].role === 'user') {
      userInfo.point = user.rows[0].point;
    }

    res.json({ token, userInfo });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/members', async (req, res) => {
  const { username } = req.body;
  try {
    const user = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
    if (user.rows.length === 0) {
      return res.status(400).json({ message: 'User not found' });
    }

    const adminId = user.rows[0].id;
    const members = await pool.query('SELECT * FROM users WHERE admin_id = $1', [adminId]);

    res.json(members.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/addMember', async (req, res) => {
  const { username, password, point, admin } = req.body;
  if (!username || !password || !point || !admin) {
    return res.status(400).json({ message: 'All fields are required' });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    
    // admin의 id를 조회합니다.
    const adminResult = await pool.query('SELECT id FROM users WHERE username = $1', [admin]);
    if (adminResult.rows.length === 0) {
      return res.status(404).json({ message: 'Admin not found' });
    }
    const adminId = adminResult.rows[0].id;

    // 회원 정보를 삽입합니다. role을 기본값 'user'로 설정합니다.
    await pool.query(
      'INSERT INTO users (username, password, point, role, admin_id) VALUES ($1, $2, $3, $4, $5)',
      [username, hashedPassword, point, 'user', adminId]
    );
    res.status(201).json({ message: 'Member added successfully' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/deleteMembers', async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: 'No IDs provided' });
  }

  try {
    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      // 삭제할 사용자들의 username 조회
      const usernamesResult = await client.query(
        'SELECT username FROM users WHERE id = ANY($1::int[])',
        [ids]
      );
      const usernames = usernamesResult.rows.map(row => row.username);

      // users 테이블에서 삭제
      const deleteUsersQuery = 'DELETE FROM users WHERE id = ANY($1::int[])';
      await client.query(deleteUsersQuery, [ids]);

      // data 테이블에서 관련 row 삭제
      const deleteDataQuery = 'DELETE FROM data WHERE id = ANY($1::text[])';
      await client.query(deleteDataQuery, [usernames]);

      await client.query('COMMIT');
      res.status(200).json({ message: 'Members deleted successfully' });
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(err);
      res.status(500).json({ message: 'Server error' });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
});

app.post('/api/updateUsedStatus', async (req, res) => {
  const { idx, used } = req.body;

  try {
    const query = `
      UPDATE data
      SET used = $1, status = $2
      WHERE idx = $3
      RETURNING *
    `;

    const status = used ? '진행' : '비활성화';
    const values = [used, status, idx];

    const result = await pool.query(query, values);
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ message: 'Reward not found' });
    }
  } catch (error) {
    console.error('Error updating used status:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

const deductWorkVolume = async () => {
  try {
    // Get all users and their work volume for active rewards
    const userWorkVolumeQuery = `
      SELECT u.username, u.point, COALESCE(SUM(d.work_volume), 0) AS total_work_volume
      FROM users u
      LEFT JOIN data d ON u.username = d.id AND d.used = true
        AND CURRENT_DATE BETWEEN d.start_date AND d.end_date
      GROUP BY u.username, u.point
    `;
    const result = await pool.query(userWorkVolumeQuery);

    for (const row of result.rows) {
      const { username, point, total_work_volume } = row;
      const newPoint = point - total_work_volume;

      console.log(`User: ${username}, Current Point: ${point}, Work Volume: ${total_work_volume}, New Point: ${newPoint}`);
    }

    // Update points for all users
    const updateQuery = `
      UPDATE users
      SET point = point - COALESCE((
        SELECT SUM(work_volume) 
        FROM data 
        WHERE id = users.username 
        AND used = true 
        AND CURRENT_DATE BETWEEN start_date AND end_date
      ), 0)
      WHERE EXISTS (
        SELECT 1 
        FROM data 
        WHERE id = users.username 
        AND used = true 
        AND CURRENT_DATE BETWEEN start_date AND end_date
      )
    `;
    await pool.query(updateQuery);

    console.log('Work volume deducted successfully');
  } catch (error) {
    console.error('Error deducting work volume:', error);
  }
};

cron.schedule('0 0 * * *', deductWorkVolume);

app.listen(port, () => {
  console.log(`App running on port ${port}.`);
});

