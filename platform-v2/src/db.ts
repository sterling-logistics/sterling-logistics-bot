import mysql, { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import { config } from './config.js';

export const db: Pool = mysql.createPool({
  uri: config.DATABASE_URL,
  connectionLimit: 10,
  waitForConnections: true,
  enableKeepAlive: true,
  keepAliveInitialDelay: 0,
  decimalNumbers: true
});

export async function withTransaction<T>(fn: (connection: PoolConnection) => Promise<T>): Promise<T> {
  const connection = await db.getConnection();
  try {
    await connection.beginTransaction();
    const result = await fn(connection);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

export async function pingDatabase(): Promise<boolean> {
  const [rows] = await db.query<RowDataPacket[]>('SELECT 1 AS ok');
  return rows[0]?.ok === 1;
}
