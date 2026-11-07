// TS-UX-1 (0.5.10): which commands need a database that exists only inside the test environment (seeds and migrations), so they are routed to the dependency's seed and never to SETUP.
import { describe, expect, it } from "vitest";
import { isDatabaseSeedCommand, parseCommandLine } from "@agentx/contracts";

const is = (line: string): boolean => isDatabaseSeedCommand(parseCommandLine(line, "svc", 900));

describe("a command that needs the test database", () => {
  it.each([
    "npm run seed", "npm run db:seed", "npm run seed:test", "yarn seed", "pnpm run db:migrate", "npm run migrate", "npx prisma db seed", "npx prisma migrate deploy", "npx knex seed:run", "npx sequelize db:migrate",
    "node scripts/seed.js", "tsx scripts/seed.ts", "python manage.py migrate", "python3 manage.py loaddata fixtures.json", "python scripts/seed_db.py", "alembic upgrade head", "flask db upgrade", "bundle exec rake db:seed", "rails db:setup",
    "make seed", "make db-migrate", "psql -f schema.sql",
  ])("%s is a seed or migration", (line) => expect(is(line)).toBe(true));
  it.each([
    "npm ci", "npm test", "npm run build", "pip install -r requirements.txt", "npx prisma generate", "python -m pytest", "make test", "node scripts/seedling-farm.js", "npm run reseed-nothing", "git clone x",
  ])("%s is not", (line) => expect(is(line)).toBe(false));
});
