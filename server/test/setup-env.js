// 测试环境统一使用 sqlite 测试库，避免依赖 MySQL。
// 若业务代码已显式设置 DATABASE_URL，则保留原值；否则默认指向 sqlite。
process.env.DATABASE_URL = process.env.DATABASE_URL || 'file:./test.db';
process.env.DB_TYPE = process.env.DB_TYPE || 'sqlite';