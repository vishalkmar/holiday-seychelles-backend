const mysql = require('mysql2/promise');

const poolImpl = mysql.createPool({
  host: process.env.DB_HOST || process.env.MYSQL_HOST || 'localhost',
  port: Number(process.env.DB_PORT || process.env.MYSQL_PORT || 3306),
  user: process.env.DB_USERNAME || process.env.MYSQL_USER || 'root',
  password: process.env.DB_PASSWORD || process.env.MYSQL_PASSWORD || '',
  database: process.env.DB_DATABASE || process.env.MYSQL_DATABASE || 'holiday_seychelles',
  waitForConnections: true,
  connectionLimit: Number(process.env.DB_POOL_LIMIT || 6),
  queueLimit: 0,
  timezone: 'Z',
  multipleStatements: true,
  // This database is remote and unhappy about bursts of new connections: a
  // fresh connect can take >10s under load while a single one takes ~1s. The
  // settings below are tuned for that host rather than for throughput.
  //
  // - a generous connectTimeout, because slow is better than failed
  // - a smaller pool, because the host tolerates few concurrent new connections
  // - idle reaping, so a socket the server already closed is never handed out
  connectTimeout: Number(process.env.DB_CONNECT_TIMEOUT_MS || 30000),
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  maxIdle: Number(process.env.DB_MAX_IDLE || 4),
  idleTimeout: Number(process.env.DB_IDLE_TIMEOUT_MS || 30000),
});

// Connection-level failures that mean "the socket died", not "the query was bad".
const TRANSIENT = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'PROTOCOL_CONNECTION_LOST',
  'ER_CON_COUNT_ERROR',
]);

function isTransient(err) {
  if (!err) return false;
  if (TRANSIENT.has(err.code) || TRANSIENT.has(err.errorno)) return true;
  // Pool-acquisition timeouts arrive without a code, only a message.
  return /ETIMEDOUT|ECONNRESET|closed state|Pool is closed/i.test(err.message || '');
}

function normalizeSql(sql) {
  return sql
    .replace(/ILIKE/gi, 'LIKE')
    .replace(/::\s*(BIGINT|INT|INTEGER|TEXT|DATE|DATETIME|VARCHAR\(\d+\)|VARCHAR|BOOLEAN|NUMERIC|JSONB|JSON)/gi, '')
    .replace(/NOW\(\)\s*-\s*INTERVAL\s+'(\d+)\s+seconds?'/gi, 'DATE_SUB(NOW(), INTERVAL $1 SECOND)')
    .replace(/NOW\(\)\s*-\s*INTERVAL\s+'(\d+)\s+minutes?'/gi, 'DATE_SUB(NOW(), INTERVAL $1 MINUTE)')
    .replace(/INTERVAL\s+'(\d+)\s+days?'/gi, 'INTERVAL $1 DAY')
    .replace(/ORDER BY ([\w.]+) DESC NULLS LAST/gi, 'ORDER BY $1 IS NULL ASC, $1 DESC')
    .replace(/ORDER BY ([\w.]+) ASC NULLS LAST/gi, 'ORDER BY $1 IS NULL ASC, $1 ASC')
    .replace(/\bTRUE\b/g, '1')
    .replace(/\bFALSE\b/g, '0');
}

function mapPgParams(sql, params = []) {
  const values = [];
  let text = normalizeSql(sql).replace(/\$(\d+)/g, (_match, index) => {
    values.push(params[Number(index) - 1]);
    return '?';
  });

  text = text.replace(/\bLIMIT\s+\?\s+OFFSET\s+\?/i, () => {
    const offset = values.pop();
    const limit = values.pop();
    return `LIMIT ${Math.max(Number(limit) || 0, 0)} OFFSET ${Math.max(Number(offset) || 0, 0)}`;
  });

  return {
    text,
    values: values.map((value) => {
      if (value && typeof value === 'object' && !(value instanceof Date) && !Buffer.isBuffer(value)) {
        return JSON.stringify(value);
      }
      return value;
    }),
  };
}

function returningInfo(sql) {
  const match = sql.match(/\s+RETURNING\s+([\s\S]+?)\s*;?\s*$/i);
  if (!match) return null;
  return {
    fields: match[1].trim(),
    sqlWithoutReturning: sql.slice(0, match.index).trim(),
  };
}

function tableFromWrite(sql, keyword) {
  const regex = new RegExp(`${keyword}\\s+(?:INTO\\s+)?([a-zA-Z0-9_]+)`, 'i');
  return sql.match(regex)?.[1];
}

function rowsResult(rows) {
  return {
    rows: Array.isArray(rows) ? rows : [],
    rowCount: Array.isArray(rows) ? rows.length : 0,
  };
}

function writerResult(result) {
  return {
    rows: [],
    rowCount: result?.affectedRows || 0,
    insertId: result?.insertId,
  };
}

class DbClient {
  constructor(connection) {
    this.connection = connection;
  }

  async query(sql, params = []) {
    const controlCommand = sql.trim().toUpperCase();
    if (['BEGIN', 'COMMIT', 'ROLLBACK', 'START TRANSACTION'].includes(controlCommand)) {
      await this.connection.query(controlCommand === 'BEGIN' ? 'START TRANSACTION' : controlCommand);
      return rowsResult([]);
    }

    const returning = returningInfo(sql);
    if (returning) {
      return this.queryReturning(sql, params, returning);
    }

    const { text, values } = mapPgParams(sql, params);
    const [result] = values.length
      ? await this.connection.execute(text, values)
      : await this.connection.query(text);
    return Array.isArray(result) ? rowsResult(result) : writerResult(result);
  }

  async queryReturning(sql, params, returning) {
    const lower = sql.trim().toLowerCase();
    const table =
      tableFromWrite(returning.sqlWithoutReturning, 'insert') ||
      tableFromWrite(returning.sqlWithoutReturning, 'update') ||
      tableFromWrite(returning.sqlWithoutReturning, 'delete');

    if (!table) {
      throw new Error(`Unable to emulate RETURNING for query: ${sql}`);
    }

    const selectAfterWrite = async (text, values, fallbackId) => {
      const whereMatch = text.match(/\bWHERE\s+([a-zA-Z0-9_.]+)\s*=\s*\?/i);
      if (whereMatch) {
        const column = whereMatch[1].split('.').pop();
        return this.connection.execute(`SELECT ${returning.fields} FROM ${table} WHERE ${column} = ?`, [values[values.length - 1]]);
      }
      return this.connection.execute(`SELECT ${returning.fields} FROM ${table} WHERE id = ?`, [fallbackId]);
    };

    if (lower.startsWith('delete')) {
      const id = params[params.length - 1];
      const { text, values } = mapPgParams(returning.sqlWithoutReturning, params);
      const [beforeRows] = await this.connection.execute(`SELECT ${returning.fields} FROM ${table} WHERE id = ?`, [id]);
      await this.connection.execute(text, values);
      return rowsResult(beforeRows);
    }

    const { text, values } = mapPgParams(returning.sqlWithoutReturning, params);
    const [writeResult] = await this.connection.execute(text, values);

    const id = lower.startsWith('insert') ? writeResult.insertId : params[params.length - 1];
    const [rows] = lower.startsWith('insert')
      ? await this.connection.execute(`SELECT ${returning.fields} FROM ${table} WHERE id = ?`, [id])
      : await selectAfterWrite(text, values, id);
    return rowsResult(rows);
  }

  async beginTransaction() {
    return this.connection.beginTransaction();
  }

  async commit() {
    return this.connection.commit();
  }

  async rollback() {
    return this.connection.rollback();
  }

  async release() {
    this.connection.release();
  }
}

const RETRY_ATTEMPTS = Number(process.env.DB_RETRY_ATTEMPTS || 3);

const pool = {
  /**
   * Run a query, retrying a dropped connection.
   *
   * Only reads are retried. A write that failed mid-flight might actually have
   * landed, so replaying it could double-insert - those surface to the caller.
   */
  async query(sql, params = []) {
    const readOnly = /^\s*(SELECT|SHOW|DESCRIBE|EXPLAIN)/i.test(sql);
    let lastError;

    for (let attempt = 1; attempt <= (readOnly ? RETRY_ATTEMPTS : 1); attempt += 1) {
      let client;
      try {
        // Acquiring the connection is inside the try on purpose: against this
        // host the timeout usually happens HERE rather than on the query, and a
        // retry that only wraps the query never gets a chance to run.
        client = await this.connect();
        return await client.query(sql, params);
      } catch (err) {
        lastError = err;
        if (!readOnly || !isTransient(err) || attempt === RETRY_ATTEMPTS) throw err;
        console.warn(`[db] ${err.code} on attempt ${attempt}, retrying`);
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      } finally {
        if (client) client.release();
      }
    }

    throw lastError;
  },

  async connect() {
    const connection = await poolImpl.getConnection();
    return new DbClient(connection);
  },

  async end() {
    return poolImpl.end();
  },
};

module.exports = { pool };
