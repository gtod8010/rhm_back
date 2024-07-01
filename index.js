const express = require("express");
const { Pool } = require("pg");
const app = express();
const port = 8006;
const cors = require("cors");
const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const cron = require('node-cron');

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const SECRET_KEY = "your_secret_key";

// PostgreSQL 연결 설정
const pool = new Pool({
  user: "dwight",
  host: "localhost",
  database: "ywdbadmin",
  password: "aabc1234",
  port: 5432,
});

const corsOptions = {
  origin: ["http://rhm.co.kr", "http://www.rhm.co.kr", "http://localhost:3000"],
  optionsSuccessStatus: 200,
};

app.use(cors(corsOptions));

// 기본 경로
app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  try {
    const user = await pool.query("SELECT * FROM users WHERE username = $1", [
      username,
    ]);
    if (user.rows.length === 0) {
      console.error(
        `Invalid credentials: No user found with username ${username}`
      );
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const hashedPassword = user.rows[0].password;
    console.log(`Database hashed password: ${hashedPassword}`);
    console.log(`Provided password: ${password}`);

    const validPassword = await bcrypt.compare(password, hashedPassword);
    console.log(`Password match: ${validPassword}`);

    if (!validPassword) {
      console.error("Invalid credentials: Password does not match");
      return res.status(400).json({ message: "Invalid credentials" });
    }

    const token = jwt.sign(
      { id: user.rows[0].id, role: user.rows[0].role },
      SECRET_KEY,
      { expiresIn: "1h" }
    );

    // 사용자 정보 반환
    let userInfo = { username: user.rows[0].username, role: user.rows[0].role };
    if (user.rows[0].role === "user") {
      userInfo.point = user.rows[0].point;
    }

    res.json({ token, userInfo });
  } catch (err) {
    console.error("Server error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------------------------------------ REWARD ------------------------------------------------ //

app.post("/api/getRewards", async (req, res) => {
  const { username } = req.body;
  try {
    const userResult = await pool.query(
      "SELECT id, role FROM users WHERE username = $1",
      [username]
    );
    if (userResult.rows.length === 0) {
      return res.status(400).json({ message: "User not found" });
    }

    const user = userResult.rows[0];
    let data;

    if (user.role === "admin") {
      // admin인 경우 admin_id가 같은 모든 reward를 반환
      data = await pool.query("SELECT * FROM data WHERE admin_id = $1", [
        user.id,
      ]);
    } else if (user.role === "user") {
      // user인 경우 자신이 등록한 reward만 반환
      data = await pool.query("SELECT * FROM data WHERE id = $1", [username]);
    } else {
      return res.status(400).json({ message: "Invalid user role" });
    }

    res.json(data.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/addReward", async (req, res) => {
  const {
    username,
    company_name,
    setting_keyword,
    final_keyword,
    place_code,
    work_volume,
    start_date,
    end_date,
  } = req.body;

  if (
    !username ||
    !company_name ||
    !setting_keyword ||
    !final_keyword ||
    !place_code ||
    !work_volume ||
    !start_date ||
    !end_date
  ) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // 유저 정보 조회
      const userResult = await client.query(
        "SELECT id, admin_id, point FROM users WHERE username = $1",
        [username]
      );
      if (userResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "User not found" });
      }
      const user = userResult.rows[0];

      // 날짜 계산
      const startDate = new Date(start_date);
      const endDate = new Date(end_date);
      const timeDiff = endDate.getTime() - startDate.getTime();
      const dayCount = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1; // 작업일 수 계산 (포함된 날들을 모두 계산)
      const requiredPoints = work_volume * dayCount; // 작업량 * 작업일 수

      // 필요 포인트 확인 및 차감
      if (user.points < requiredPoints) {
        await client.query("ROLLBACK");
        return res.status(400).json({ message: "Insufficient points" });
      }

      await client.query("UPDATE users SET point = point - $1 WHERE id = $2", [
        requiredPoints,
        user.id,
      ]);

      // 새 인덱스 및 리워드 번호 생성
      const idxResult = await client.query(
        "SELECT COALESCE(MAX(idx)::int, 0) + 1 AS idx FROM data"
      );
      const rewardNoResult = await client.query(
        "SELECT COALESCE(MAX(reward_no)::int, 0) + 1 AS reward_no FROM data"
      );
      const idx = idxResult.rows[0].idx;
      const rewardNo = rewardNoResult.rows[0].reward_no;

      // 리워드 등록
      const insertResult = await client.query(
        `INSERT INTO data (
          idx, id, reward_no, reward_type, used, status, company_name, place_code,
          setting_keyword, final_keyword, start_date, end_date, work_volume, admin_id
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14
        ) RETURNING *`,
        [
          idx,
          username,
          rewardNo,
          "플레이스(저장)",
          false,
          "비활성화",
          company_name,
          place_code,
          setting_keyword,
          final_keyword,
          startDate,
          endDate,
          work_volume,
          user.admin_id,
        ]
      );

      const newReward = insertResult.rows[0];

      // 포인트 사용 내역 기록
      await client.query(
        `INSERT INTO point_history (
          user_id, date, username, category, point, company_name
        ) VALUES (
          $1, CURRENT_TIMESTAMP, $2, $3, $4, $5
        )`,
        [user.id, username, "리워드 추가", -requiredPoints, company_name]
      );

      // 리워드 히스토리 기록
      await client.query(
        `INSERT INTO reward_history (
          user_id, date, username, category, points, company_name
        ) VALUES (
          $1, CURRENT_TIMESTAMP, $2, $3, $4, $5
        )`,
        [user.id, username, "리워드 추가", -requiredPoints, company_name]
      );

      await client.query("COMMIT");

      res.status(201).json(newReward);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Transaction error:", err);
      res.status(500).json({ message: "Server error" });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Database connection error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/extendReward", async (req, res) => {
  const { idx, end_date } = req.body;
  if (!idx || !end_date) {
    return res.status(400).json({ message: "IDX and end_date are required" });
  }

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // 기존 리워드 조회
      const rewardResult = await client.query(
        "SELECT * FROM data WHERE idx = $1",
        [idx]
      );
      if (rewardResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "Reward not found" });
      }
      const reward = rewardResult.rows[0];

      // 날짜 계산
      const oldEndDate = new Date(reward.end_date);
      const newEndDate = new Date(end_date);
      const startDate = new Date(reward.start_date);

      const oldDays =
        Math.ceil((oldEndDate - startDate) / (1000 * 3600 * 24)) + 1;
      const newDays =
        Math.ceil((newEndDate - startDate) / (1000 * 3600 * 24)) + 1;

      let adjustment = 0;
      if (newDays > oldDays) {
        // 늘었을 때
        adjustment = (oldDays - newDays) * reward.work_volume;
      } else if (newDays < oldDays) {
        // 줄었을 때
        adjustment = (oldDays - newDays) * reward.work_volume;
      }
      console.log("oldDays:", oldDays);
      console.log("newDays:", newDays);
      console.log("계산된 날짜는 :", newDays - oldDays);
      console.log("adjustment:", adjustment);

      // 포인트 조정 (날짜가 늘어나면 포인트 감소, 날짜가 줄어들면 포인트 증가)
      await client.query(
        "UPDATE users SET point = point + $1 WHERE username = $2",
        [adjustment, reward.id]
      );

      // 사용자 ID 조회
      const userResult = await client.query(
        "SELECT id FROM users WHERE username = $1",
        [reward.id]
      );
      if (userResult.rows.length === 0) {
        await client.query("ROLLBACK");
        return res.status(404).json({ message: "User not found" });
      }
      const userId = userResult.rows[0].id;

      // 구분 내용 구성
      const category = `기간 변경 ${oldDays}일 -> ${newDays}일 (${formatDate(
        startDate
      )} ~ ${formatDate(oldEndDate)} -> ${formatDate(startDate)} ~ ${formatDate(
        newEndDate
      )})`;

      // 포인트 히스토리 기록
      await client.query(
        "INSERT INTO point_history (user_id, date, username, category, point, company_name) VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4, $5)",
        [userId, reward.id, category, adjustment, reward.company_name]
      );

      // 리워드 히스토리 기록
      await client.query(
        "INSERT INTO reward_history (user_id, date, username, category, points, company_name) VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4, $5)",
        [userId, reward.id, category, adjustment, reward.company_name]
      );

      // 리워드 연장
      const query = "UPDATE data SET end_date = $2 WHERE idx = $1 RETURNING *";
      const values = [idx, newEndDate];
      const result = await client.query(query, values);

      await client.query("COMMIT");
      res.status(200).json(result.rows[0]);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Error extending reward:", err);
      res.status(500).json({ message: "Server error" });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Database connection error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// 날짜 형식을 YYYY/MM/DD로 변환하는 헬퍼 함수
function formatDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

app.post("/api/extendMultipleRewards", async (req, res) => {
  const { rewards } = req.body;

  try {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const updatedRewards = await Promise.all(
        rewards.map(async (reward) => {
          const { idx, end_date } = reward;

          // 기존 리워드 조회
          const rewardResult = await client.query(
            "SELECT * FROM data WHERE idx = $1",
            [idx]
          );
          if (rewardResult.rows.length === 0) {
            throw new Error("Reward not found");
          }
          const existingReward = rewardResult.rows[0];

          // 날짜 계산
          const oldEndDate = new Date(existingReward.end_date);
          const newEndDate = new Date(end_date);

          const oldDays =
            Math.ceil(
              (oldEndDate - new Date(existingReward.start_date)) /
                (1000 * 3600 * 24)
            ) + 1;
          const newDays =
            Math.ceil(
              (newEndDate - new Date(existingReward.start_date)) /
                (1000 * 3600 * 24)
            ) + 1;

          let adjustment = 0;
          if (newEndDate > oldEndDate) {
            adjustment = (oldDays - newDays) * reward.work_volume;
          } else if (newEndDate < oldEndDate) {
            adjustment = (oldDays - newDays) * reward.work_volume;
          }

          console.log("oldDays:", oldDays);
          console.log("newDays:", newDays);
          console.log("adjustment:", adjustment);

          // 포인트 조정
          await client.query(
            "UPDATE users SET point = point + $1 WHERE username = $2",
            [adjustment, existingReward.id]
          );

          // 사용자 ID 조회
          const userResult = await client.query(
            "SELECT id FROM users WHERE username = $1",
            [existingReward.id]
          );
          if (userResult.rows.length === 0) {
            throw new Error("User not found");
          }
          const userId = userResult.rows[0].id;

          // 히스토리 기록
          await client.query(
            "INSERT INTO point_history (user_id, date, username, category, point, company_name) VALUES ($1, CURRENT_TIMESTAMP, $2, $3, $4, $5)",
            [
              userId,
              existingReward.id,
              "리워드 연장/변경",
              adjustment,
              existingReward.company_name,
            ]
          );

          // 리워드 연장
          const result = await client.query(
            "UPDATE data SET end_date = $1 WHERE idx = $2 RETURNING *",
            [newEndDate, idx]
          );
          return result.rows[0];
        })
      );

      await client.query("COMMIT");
      res.json(updatedRewards);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(500).json({ message: "Server error" });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("Database connection error:", err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/deleteRewards", async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: "No IDs provided" });
  }

  try {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // 삭제된 리워드 정보 조회
      const deleteQuery = `DELETE FROM data WHERE idx = ANY($1::int[]) RETURNING *`;
      const deleteResult = await client.query(deleteQuery, [ids]);
      const deletedRewards = deleteResult.rows;

      // 각 삭제된 리워드의 포인트 회수 및 포인트 히스토리에 기록
      for (let reward of deletedRewards) {
        const {
          id: username,
          work_volume,
          start_date,
          end_date,
          company_name,
        } = reward;

        // 날짜 계산
        const startDate = new Date(start_date);
        const endDate = new Date(end_date);
        const currentDate = new Date();
        currentDate.setHours(0, 0, 0, 0); // 현재 날짜를 자정으로 설정하여 시간 부분을 제거

        console.log(startDate);
        console.log(endDate);
        console.log(currentDate);

        // 삭제하려는 날짜가 종료된 날짜 이전인 경우에만 회수할 포인트 계산
        if (currentDate <= endDate) {
          // 시작일과 현재 날짜 중 더 늦은 날짜 선택
          const effectiveStartDate = new Date(
            Math.max(startDate.getTime(), currentDate.getTime())
          );

          const timeDiff = endDate.getTime() - effectiveStartDate.getTime();
          const dayCount = Math.ceil(timeDiff / (1000 * 3600 * 24)) + 1; // 작업일 수 계산 (포함된 날들을 모두 계산)
          const requiredPoints = work_volume * dayCount; // 작업량 * 작업일 수

          console.log(effectiveStartDate);
          console.log(timeDiff);
          console.log(dayCount);
          console.log(requiredPoints);

          // 사용자 정보 조회
          const userResult = await client.query(
            "SELECT id, point FROM users WHERE username = $1",
            [username]
          );
          if (userResult.rows.length === 0) {
            await client.query("ROLLBACK");
            return res.status(404).json({ message: "User not found" });
          }
          const user = userResult.rows[0];

          // 포인트 회수
          await client.query(
            "UPDATE users SET point = point + $1 WHERE id = $2",
            [requiredPoints, user.id]
          );

          // 포인트 히스토리 기록
          await client.query(
            `INSERT INTO point_history (
              user_id, date, username, category, point, company_name
            ) VALUES (
              $1, CURRENT_TIMESTAMP, $2, $3, $4, $5
            )`,
            [
              user.id,
              username,
              "리워드 삭제 회수",
              requiredPoints,
              company_name,
            ]
          );

          await client.query(
            `INSERT INTO reward_history (
              user_id, date, username, category, company_name, points
            ) VALUES (
              $1,CURRENT_TIMESTAMP, $2, $3, $4, $5
            )`,
            [
              user.id,
              username,
              '리워드 삭제',
              company_name,
              requiredPoints
            ]
          );
        }
      }

      await client.query("COMMIT");
      res.status(200).json({ message: "Rewards deleted successfully" });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(500).json({ message: "Server error" });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/updateUsedStatus", async (req, res) => {
  const { idx, used } = req.body;

  try {
    const query = `
      UPDATE data
      SET used = $1, status = $2
      WHERE idx = $3
      RETURNING *
    `;

    const status = used ? "진행" : "비활성화";
    const values = [used, status, idx];

    const result = await pool.query(query, values);
    if (result.rows.length > 0) {
      res.json(result.rows[0]);
    } else {
      res.status(404).json({ message: "Reward not found" });
    }
  } catch (error) {
    console.error("Error updating used status:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------------------------------------ MEMBER ------------------------------------------------ //

app.post("/api/members", async (req, res) => {
  const { username } = req.body;
  try {
    const user = await pool.query("SELECT id FROM users WHERE username = $1", [
      username,
    ]);
    if (user.rows.length === 0) {
      return res.status(400).json({ message: "User not found" });
    }

    const adminId = user.rows[0].id;
    const members = await pool.query(
      "SELECT * FROM users WHERE admin_id = $1",
      [adminId]
    );

    res.json(members.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/getMember", async (req, res) => {
  const { username } = req.body;
  try {
    const userResult = await pool.query(
      "SELECT username, point FROM users WHERE username = $1",
      [username]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ message: "User not found" });
    }
    const user = userResult.rows[0];
    res.json(user);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/addMember", async (req, res) => {
  const { username, password, point, agency, admin } = req.body;
  if (!username || !password || !point || !agency || !admin) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    // admin의 id를 조회합니다.
    const adminResult = await pool.query(
      "SELECT id FROM users WHERE username = $1",
      [admin]
    );
    if (adminResult.rows.length === 0) {
      return res.status(404).json({ message: "Admin not found" });
    }
    const adminId = adminResult.rows[0].id;

    // 회원 정보를 삽입합니다. role을 기본값 'user'로 설정합니다.
    await pool.query(
      "INSERT INTO users (username, password, point, role, agency, admin_id) VALUES ($1, $2, $3, $4, $5, $6)",
      [username, hashedPassword, point, "user", agency, adminId]
    );
    res.status(201).json({ message: "Member added successfully" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/editMember", async (req, res) => {
  const { id, username, point, agency } = req.body;
  let query = "";
  let values = "";
  if (!id || !username || !point || !agency) {
    return res.status(400).json({ message: "All fields are required" });
  }

  try {
    query =
      "UPDATE users SET username = $1, point = $2, agency = $3 WHERE id = $4 RETURNING *";
    values = [username, point, agency, id];

    const result = await pool.query(query, values);

    if (result.rows.length === 0) {
      return res.status(404).json({ message: "Member not found" });
    }

    const updatedMember = result.rows[0];
    res.json(updatedMember);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/deleteMembers", async (req, res) => {
  const { ids } = req.body;
  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ message: "No IDs provided" });
  }

  try {
    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      // 삭제할 사용자들의 username 조회
      const usernamesResult = await client.query(
        "SELECT username FROM users WHERE id = ANY($1::int[])",
        [ids]
      );
      const usernames = usernamesResult.rows.map((row) => row.username);

      // users 테이블에서 삭제
      const deleteUsersQuery = "DELETE FROM users WHERE id = ANY($1::int[])";
      await client.query(deleteUsersQuery, [ids]);

      // data 테이블에서 관련 row 삭제
      const deleteDataQuery = "DELETE FROM data WHERE id = ANY($1::text[])";
      await client.query(deleteDataQuery, [usernames]);

      await client.query("COMMIT");
      res.status(200).json({ message: "Members deleted successfully" });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error(err);
      res.status(500).json({ message: "Server error" });
    } finally {
      client.release();
    }
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------------------------------------ HISTORY ------------------------------------------------ //

app.post("/api/pointHistory", async (req, res) => {
  const { username, role } = req.body;

  try {
    let query = "";
    let values = [];

    if (role === "admin") {
      // Get the admin user's ID
      const adminResult = await pool.query(
        "SELECT id FROM users WHERE username = $1",
        [username]
      );
      const adminId = adminResult.rows[0].id;

      // Get the point history for all users under this admin
      query = `
        SELECT ph.id, ph.date, ph.username, ph.category, ph.point, ph.company_name 
        FROM point_history ph
        JOIN users u ON ph.user_id = u.id
        WHERE u.admin_id = $1 OR u.id = $1
        ORDER BY ph.date DESC
      `;
      values = [adminId];
    } else if (role === "user") {
      // Get the point history for the user
      query = `
        SELECT id, date, username, category, point, company_name 
        FROM point_history 
        WHERE username = $1
        ORDER BY date DESC
      `;
      values = [username];
    } else {
      return res.status(400).json({ message: "Invalid role" });
    }

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/filteredPointHistory", async (req, res) => {
  const { agency, company_name, startDate, endDate, username, role } = req.body;

  try {
    let query = "";
    let values = [];

    if (role === "admin") {
      // Get the admin user's ID
      const adminResult = await pool.query(
        "SELECT id FROM users WHERE username = $1",
        [username]
      );
      const adminId = adminResult.rows[0].id;

      // Get the point history for all users under this admin
      query = `
        SELECT ph.id, ph.date, ph.username, ph.category, ph.point, ph.company_name 
        FROM point_history ph
        JOIN users u ON ph.user_id = u.id
        WHERE u.admin_id = $1
      `;
      values = [adminId];

      if (agency) {
        query += " AND u.agency = $" + (values.length + 1);
        values.push(agency);
      }

      if (company_name) {
        query += " AND ph.company_name = $" + (values.length + 1);
        values.push(company_name);
      }

      if (startDate) {
        query += " AND ph.date >= $" + (values.length + 1);
        values.push(startDate);
      }

      if (endDate) {
        query += " AND ph.date <= $" + (values.length + 1);
        values.push(endDate);
      }
    } else if (role === "user") {
      // Get the user's ID
      const userResult = await pool.query(
        "SELECT id FROM users WHERE username = $1",
        [username]
      );
      const userId = userResult.rows[0].id;

      // Get the point history for the user
      query = `
        SELECT id, date, username, category, point, company_name 
        FROM point_history 
        WHERE user_id = $1
      `;
      values = [userId];

      if (agency) {
        query += " AND agency = $" + (values.length + 1);
        values.push(agency);
      }

      if (company_name) {
        query += " AND company_name = $" + (values.length + 1);
        values.push(company_name);
      }

      if (startDate) {
        query += " AND date >= $" + (values.length + 1);
        values.push(startDate);
      }

      if (endDate) {
        query += " AND date <= $" + (values.length + 1);
        values.push(endDate);
      }
    } else {
      return res.status(400).json({ message: "Invalid role" });
    }

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});


app.post("/api/rewardHistory", async (req, res) => {
  const { username, role } = req.body;

  try {
    let query = "";
    let values = [];

    if (role === "admin") {
      // Get the admin user's ID
      const adminResult = await pool.query(
        "SELECT id FROM users WHERE username = $1",
        [username]
      );
      const adminId = adminResult.rows[0].id;

      // Get the reward history for all users under this admin
      query = `
        SELECT rh.id, rh.date, rh.username, rh.category, rh.points, rh.company_name 
        FROM reward_history rh
        JOIN users u ON rh.user_id = u.id
        WHERE u.admin_id = $1 OR u.id = $1
        ORDER BY rh.date DESC
      `;
      values = [adminId];
    } else if (role === "user") {
      // Get the reward history for the user
      query = `
        SELECT id, date, username, category, points, company_name 
        FROM reward_history 
        WHERE username = $1
        ORDER BY date DESC
      `;
      values = [username];
    } else {
      return res.status(400).json({ message: "Invalid role" });
    }

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/filteredRewardHistory", async (req, res) => {
  const { agency, companyName, startDate, endDate, username, role } = req.body;

  try {
    let query = "";
    let values = [];
    let conditions = [];
    let counter = 1;

    if (role === "admin") {
      // Get the admin user's ID
      const adminResult = await pool.query(
        "SELECT id FROM users WHERE username = $1",
        [username]
      );
      const adminId = adminResult.rows[0].id;

      conditions.push(`(u.admin_id = $${counter} OR u.id = $${counter})`);
      values.push(adminId);
      counter++;
    } else if (role === "user") {
      conditions.push(`username = $${counter}`);
      values.push(username);
      counter++;
    } else {
      return res.status(400).json({ message: "Invalid role" });
    }

    if (agency) {
      conditions.push(`u.username LIKE $${counter}`);
      values.push(`%${agency}%`);
      counter++;
    }

    if (companyName) {
      conditions.push(`rh.company_name LIKE $${counter}`);
      values.push(`%${companyName}%`);
      counter++;
    }

    if (startDate) {
      conditions.push(`rh.date >= $${counter}`);
      values.push(startDate);
      counter++;
    }

    if (endDate) {
      conditions.push(`rh.date <= $${counter}`);
      values.push(endDate);
      counter++;
    }

    query = `
      SELECT rh.id, rh.date, rh.username, rh.category, rh.points, rh.company_name 
      FROM reward_history rh
      JOIN users u ON rh.user_id = u.id
      ${conditions.length > 0 ? "WHERE " + conditions.join(" AND ") : ""}
      ORDER BY rh.date DESC
    `;

    const result = await pool.query(query, values);
    res.json(result.rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: "Server error" });
  }
});

// ------------------------------------------------ workVolumeHistory ------------------------------------------------ //
const generateGender = () => (Math.random() > 0.5 ? '남' : '녀');
const generateAgeGroup = () => {
  const ageGroups = ['10대', '20대', '30대', '40대', '50대'];
  return ageGroups[Math.floor(Math.random() * ageGroups.length)];
};

const generateKoreanIPAddress = () => {
  const koreanIPRanges = [
    { start: '14.0.0.0', end: '14.63.255.255' },
    { start: '58.140.0.0', end: '58.143.255.255' },
    { start: '61.32.0.0', end: '61.39.255.255' },
    { start: '101.0.0.0', end: '101.255.255.255' },
    { start: '110.0.0.0', end: '110.255.255.255' },
    { start: '121.128.0.0', end: '121.191.255.255' },
    { start: '175.192.0.0', end: '175.223.255.255' },
    { start: '180.64.0.0', end: '180.127.255.255' },
    { start: '210.0.0.0', end: '210.255.255.255' },
    { start: '211.0.0.0', end: '211.255.255.255' },
    { start: '218.0.0.0', end: '218.255.255.255' },
    { start: '220.0.0.0', end: '220.255.255.255' },
    { start: '222.0.0.0', end: '222.255.255.255' }
  ];

  const ipToNumber = (ip) => ip.split('.').reduce((acc, octet) => (acc << 8) + parseInt(octet, 10), 0);
  const numberToIP = (number) => [number >>> 24, (number >>> 16) & 255, (number >>> 8) & 255, number & 255].join('.');

  const range = koreanIPRanges[Math.floor(Math.random() * koreanIPRanges.length)];
  const start = ipToNumber(range.start);
  const end = ipToNumber(range.end);
  const randomIPNumber = Math.floor(Math.random() * (end - start + 1)) + start;
  const randomIP = numberToIP(randomIPNumber);
  const maskedIP = maskIPAddress(randomIP);
  return maskedIP;
};

const maskIPAddress = (ip) => {
  const octets = ip.split('.');
  octets[2] = octets[2][0] + '*' + octets[2].slice(2);
  octets[3] = octets[3][0] + '*' + octets[3].slice(2);
  return octets.join('.');
};

// 랜덤한 시간 생성 함수 (30분 전부터 현재까지)
const generateRandomPastTime = () => {
  const now = new Date();
  const start = new Date(now.getTime() - 30 * 60 * 1000); // 30분 전
  const randomTime = new Date(start.getTime() + Math.random() * (now.getTime() - start.getTime()));
  return randomTime;
};

// 매 30분마다 작업량 데이터를 생성하여 DB에 입력
const insertDailyWorkVolume = async () => {
  try {
    const result = await pool.query('SELECT * FROM data WHERE start_date <= NOW() AND end_date >= NOW()');

    for (let reward of result.rows) {
      const today = new Date();
      const startDate = new Date(reward.start_date);
      const endDate = new Date(reward.end_date);

      if (today >= startDate && today <= endDate) {
        const workVolumeResult = await pool.query('SELECT COUNT(*) FROM work_volume_history WHERE reward_id = $1 AND access_time::date = NOW()::date', [reward.idx]);
        const currentWorkVolume = parseInt(workVolumeResult.rows[0].count, 10);
        const remainingVolume = reward.work_volume - currentWorkVolume;

        if (remainingVolume > 0) {
          const insertVolume = Math.ceil(remainingVolume / ((24 - today.getHours()) * 2)); // 남은 시간을 30분 단위로 나누어 추가

          for (let i = 0; i < insertVolume; i++) {
            const randomTime = generateRandomPastTime();
            await pool.query(
              'INSERT INTO work_volume_history (reward_id, gender, age_group, ip_address, access_time) VALUES ($1, $2, $3, $4, $5)',
              [reward.idx, generateGender(), generateAgeGroup(), generateKoreanIPAddress(), randomTime]
            );
          }
        }
      }
    }
  } catch (error) {
    console.error('Error inserting daily work volume:', error);
  }
};

// 일주일이 지난 데이터 삭제 함수
const deleteOldWorkVolumeHistory = async () => {
  try {
    await pool.query('DELETE FROM work_volume_history WHERE access_time < NOW() - INTERVAL \'7 days\'');
  } catch (error) {
    console.error('Error deleting old work volume history:', error);
  }
};

const updateRewardStatus = async () => {
  try {
    await pool.query(`
      UPDATE data 
      SET status = CASE 
        WHEN start_date <= NOW() AND end_date >= NOW() THEN '활성화'
        ELSE '비활성화'
      END
    `);
  } catch (error) {
    console.error('Error updating reward status:', error);
  }
};

// 스케줄러 설정 (30분마다 실행)
cron.schedule('*/1 * * * *', () => {
  deleteOldWorkVolumeHistory();
  updateRewardStatus();
  console.log('insertDailyWorkVolume and deleteOldWorkVolumeHistory executed');
});

// 스케줄러 설정 (30분마다 실행)
cron.schedule('*/30 * * * *', () => {
  insertDailyWorkVolume();
  console.log('insertDailyWorkVolume executed');
});

// API 엔드포인트 설정
app.get('/api/workVolumeHistory/:rewardId', async (req, res) => {
  const { rewardId } = req.params;
  try {
    const result = await pool.query('SELECT * FROM work_volume_history WHERE reward_id = $1 ORDER BY access_time DESC', [rewardId]);
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching work volume history:', error);
    res.status(500).json({ message: 'Server error' });
  }
});

app.listen(port, () => {
  console.log(`App running on port ${port}.`);
});
