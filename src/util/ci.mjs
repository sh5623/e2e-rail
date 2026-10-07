// Running under CI: `CI` is set to anything but an explicit no (`0`, `false`). The one reading of CI that select (no
// uncommitted files by default) and run (run.workers.ci) share.
export const inCI = () => Boolean(process.env.CI) && !/^(0|false)$/i.test(process.env.CI);
