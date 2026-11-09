/**
 * Test utilities. `FakeDrive` is an in-memory Drive v3 stand-in that enforces Drive's
 * appProperties and resumable-chunk rules. Use it to unit-test code built on DriveAdapter:
 *
 *   const adapter = new DriveAdapter({ api: new FakeDrive() });
 */
export { FakeDrive, httpError, compileQuery } from './fake-drive.js';
