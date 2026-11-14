#!/usr/bin/env node
// Prints the arguments it got, as one JSON line, so the spike can compare them with what it sent.
process.stdout.write(JSON.stringify(process.argv.slice(2)) + '\n');
