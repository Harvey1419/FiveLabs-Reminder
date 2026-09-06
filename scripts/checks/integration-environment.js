import 'dotenv/config';
import { configureIntegrationEnvironment } from '../../tests/support/integration/configure-environment.js';

try {
  configureIntegrationEnvironment();
} catch (error) {
  console.error(`\n❌ ${error.message}\n`);
  process.exitCode = 1;
}
