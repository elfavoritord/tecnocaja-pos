const fs = require('fs');
const path = require('path');
const mysql = require('mysql2/promise');
const { prepareRuntimeEnvironment } = require('./runtime-bootstrap');

function getMysqlEnv() {
  prepareRuntimeEnvironment({
    appRoot: path.join(__dirname, '..'),
    userDataPath: process.env.TECNO_CAJA_USER_DATA || ''
  });

  return {
    host: process.env.DB_HOST || '127.0.0.1',
    port: Number(process.env.DB_PORT || 3306),
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'tecnocaja'
  };
}

function buildStatements(schemaSql, databaseName) {
  const normalizedSql = String(schemaSql || '')
    .replace(/CREATE DATABASE IF NOT EXISTS\s+[^;]+;/i, `CREATE DATABASE IF NOT EXISTS \`${databaseName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;`)
    .replace(/^\s*USE\s+[^;]+;/gim, '');

  return normalizedSql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function initializeMySqlDatabase() {
  const env = getMysqlEnv();
  const schemaPath = path.join(__dirname, '..', 'db', 'schema.sql');
  const schemaSql = fs.readFileSync(schemaPath, 'utf8');
  const statements = buildStatements(schemaSql, env.database);

  const serverConnection = await mysql.createConnection({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    multipleStatements: false
  });

  try {
    await serverConnection.query(
      `CREATE DATABASE IF NOT EXISTS \`${env.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`
    );
  } finally {
    await serverConnection.end();
  }

  const dbConnection = await mysql.createConnection({
    host: env.host,
    port: env.port,
    user: env.user,
    password: env.password,
    database: env.database,
    multipleStatements: false
  });

  try {
    await dbConnection.query('SET FOREIGN_KEY_CHECKS = 0');
    for (const statement of statements) {
      if (/^CREATE DATABASE\b/i.test(statement) || /^USE\b/i.test(statement)) continue;
      await dbConnection.query(statement);
    }
    await dbConnection.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log(`Base de datos MySQL inicializada correctamente en ${env.database}.`);
  } finally {
    await dbConnection.end();
  }
}

if (require.main === module) {
  initializeMySqlDatabase().catch((error) => {
    console.error('No se pudo inicializar la base de datos MySQL.');
    console.error(error.message);
    process.exit(1);
  });
}

module.exports = {
  initializeMySqlDatabase
};
