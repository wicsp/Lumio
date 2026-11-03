// Tests start from the default (English) output regardless of the developer's shell locale.
// Tests that need Chinese set LUMIO_LANG / LANG explicitly for themselves or their subprocesses.
for (const name of ["LUMIO_LANG", "LC_ALL", "LC_MESSAGES"]) delete process.env[name];
process.env.LANG = "en_US.UTF-8";
