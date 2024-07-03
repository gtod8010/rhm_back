const { Pool } = require('pg');
const bcrypt = require('bcrypt');

const pool = new Pool({
  user: "dwight",
  host: "localhost",
  database: "ywdbadmin",
  password: "aabc1234",
  port: 5432,
});

const users = [
  { username: 'cde1019', password: 'Skrtjwkd0!@' },
  { username: 'ehwns97', password: 'ehwnsdl97' },
  { username: 'intheigloo', password: 'intheigloo1' },
  { username: 'lee6231', password: 'th3020' },
  { username: 'kja6653', password: '!!kwon5880' },
  { username: 'rlaeotjd97', password: 'sksmswkd97' },
];

const insertUsers = async () => {
  try {
    const client = await pool.connect();
    await client.query('BEGIN');

    // 기존 데이터 삭제
    await client.query('DELETE FROM users');
    console.log('All existing users deleted');

    for (const [index, user] of users.entries()) {
      const hashedPassword = await bcrypt.hash(user.password, 10);
      const query = `
        INSERT INTO users (username, password, role, admin_id, created_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `;
      const values = [user.username, hashedPassword, 'admin', null, new Date()];
      const res = await client.query(query, values);
      console.log(`Inserted user ${user.username} with ID: ${res.rows[0].id}`);
    }

    await client.query('COMMIT');
    console.log('All users inserted successfully');
  } catch (err) {
    console.error('Error inserting users:', err);
    await pool.query('ROLLBACK');
  } finally {
    pool.end();
  }
};

insertUsers();
