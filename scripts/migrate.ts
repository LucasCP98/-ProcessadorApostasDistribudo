import { MikroORM } from '@mikro-orm/postgresql';
import { databaseOptions } from '../src/shared/infrastructure/database/database.config.js';

const action = process.argv[2] ?? 'up';
const orm = await MikroORM.init(databaseOptions);

try {
  const migrator = orm.migrator;
  if (action === 'up') {
    await migrator.up();
  } else if (action === 'down') {
    await migrator.down();
  } else {
    throw new Error(`Unsupported migration action: ${action}`);
  }
} finally {
  await orm.close(true);
}
