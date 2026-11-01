// Runs before every test file: the suite must never touch a real MongoDB,
// even if the developer's shell exports MONGODB_URI. Tests needing the
// Mongo backend use the in-memory fake (see mongo-store.test.ts) or set
// the variable explicitly within the test.
delete process.env.MONGODB_URI;
