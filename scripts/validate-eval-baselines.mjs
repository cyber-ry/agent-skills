#!/usr/bin/env node

// A baseline holds results for a specific set of evals run against a specific
// model matrix. When either drifts, reports keep comparing against it instead of
// failing, so a stale baseline reads as a valid one. Staleness is the real target
// here; a missing baseline is at least visible.

import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const skillsRoot = path.join(repoRoot, "skills");
const errors = [];

const REQUIRED_BASELINE_FILES = [
  "baseline.json",
  "model-matrix.json",
  "aggregate-benchmark.json",
];

// Fields that change what a run measures. Presentation-only fields are ignored.
const MATRIX_FIELDS = ["models", "configurations", "repetitions", "judge_model"];

function addError(message) {
  errors.push(message);
}

async function readJsonFile(filePath, context) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    addError(`${context} could not be read: ${relative(filePath)} (${error.message})`);
    return null;
  }
}

function relative(target) {
  return path.relative(repoRoot, target);
}

async function listDirectories(target) {
  try {
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

// Both files are what the runner treats as a suite, so requiring the same pair
// keeps this from demanding baselines for a directory that cannot be run yet.
async function findEvalSuites() {
  const suites = [];
  for (const skill of await listDirectories(skillsRoot)) {
    const evalsDir = path.join(skillsRoot, skill, "evals");
    for (const suite of await listDirectories(evalsDir)) {
      const suiteDir = path.join(evalsDir, suite);
      try {
        await fs.access(path.join(suiteDir, "evals.json"));
        await fs.access(path.join(suiteDir, "model-matrix.json"));
        suites.push({ skill, suite, suiteDir });
      } catch {
        // Not a runnable eval suite; the runner skips these too.
      }
    }
  }
  return suites.sort((left, right) => relative(left.suiteDir).localeCompare(relative(right.suiteDir)));
}

// No --iteration: eval:baseline resolves it from the matrix's default_iteration,
// so a hardcoded iteration-1 would re-promote an older run's results.
function promoteHint({ skill, suite }) {
  return `npm run eval:baseline -- --skill ${skill} --suite ${suite}`;
}

// Compared as a set: reordering the model list does not change what was measured.
function sameValue(left, right) {
  if (Array.isArray(left) && Array.isArray(right)) {
    if (left.length !== right.length) return false;
    const sortedLeft = [...left].map(String).sort();
    const sortedRight = [...right].map(String).sort();
    return sortedLeft.every((value, index) => value === sortedRight[index]);
  }
  return left === right;
}

function describe(value) {
  return Array.isArray(value) ? `[${value.join(", ")}]` : String(value);
}

// Mirrors how the aggregate names an eval: trimmed, falling back to eval-<id>
// when blank. Diverging here would fail a suite straight after a valid promote.
function evalKey(id, name) {
  const trimmed = typeof name === "string" ? name.trim() : "";
  return `${id}:${trimmed || `eval-${id}`}`;
}

function checkMatrix(suite, current, baseline) {
  // Comparison is order-insensitive, so a duplicate would match a duplicate. The
  // runner schedules one task per entry and writes per model, so repeats collide.
  for (const field of ["models", "configurations"]) {
    const values = current?.[field];
    if (!Array.isArray(values)) continue;
    const repeated = [...new Set(values.filter((v, i) => values.indexOf(v) !== i))];
    if (repeated.length > 0) {
      addError(
        `${suite.skill}/${suite.suite}: model-matrix.json ${field} repeats ` +
          `${repeated.join(", ")}. Each entry schedules its own run, so repeats ` +
          `overwrite the same output paths.`
      );
    }
  }

  for (const field of MATRIX_FIELDS) {
    if (!sameValue(current?.[field], baseline?.[field])) {
      addError(
        `${suite.skill}/${suite.suite}: baseline was run with a different ${field} ` +
          `(baseline ${describe(baseline?.[field])}, suite now ${describe(current?.[field])}). ` +
          `Re-run the suite and promote it: ${promoteHint(suite)}`
      );
    }
  }
}

// Every file here names the suite it belongs to, and the runner resolves the
// skill directory from evals.json's skill_name, so a wrong name runs against
// another skill rather than failing. The directory is the ground truth.
function checkIdentity(suite, evalsFile, currentMatrix, baseline, benchmark) {
  // required mirrors the runner: it demands evals.json's two fields and treats
  // model-matrix.json's eval_suite as optional.
  const claimed = [
    ["evals.json skill_name", evalsFile.skill_name, suite.skill, true],
    ["evals.json eval_suite", evalsFile.eval_suite, suite.suite, true],
    ["model-matrix.json eval_suite", currentMatrix.eval_suite, suite.suite, false],
    ["baseline.json skill_name", baseline.skill_name, suite.skill, true],
    ["baseline.json eval_suite", baseline.eval_suite, suite.suite, true],
    ["aggregate context.skill_name", benchmark.context?.skill_name, suite.skill, true],
    ["aggregate context.suite_name", benchmark.context?.suite_name, suite.suite, true],
  ];

  for (const [field, actual, expected, required] of claimed) {
    if (actual === undefined) {
      if (required) {
        addError(
          `${suite.skill}/${suite.suite}: ${field} is missing. The eval runner ` +
            `requires it, so the suite would fail to run.`
        );
      }
      continue;
    }
    if (actual !== expected) {
      addError(
        `${suite.skill}/${suite.suite}: ${field} is "${actual}" but this directory ` +
          `is "${expected}". The eval runner resolves the skill and suite from these ` +
          `fields, so they must match the directory they sit in.`
      );
    }
  }
}

function checkEvalSet(suite, evalsFile, benchmark) {
  // A malformed evals field should read as a validation error, not a TypeError
  // out of .map that aborts the whole run.
  for (const [label, value] of [
    ["evals.json evals", evalsFile.evals],
    ["baseline aggregate evals", benchmark.evals],
  ]) {
    if (!Array.isArray(value)) {
      addError(`${suite.skill}/${suite.suite}: ${label} is not an array.`);
      return;
    }
  }

  const expected = evalsFile.evals.map((item) => evalKey(item.id, item.name));
  const recorded = benchmark.evals.map((item) => evalKey(item.eval_id, item.eval_name));

  // The runner derives each run's output directory from the eval id, so two evals
  // sharing an id overwrite each other's results instead of failing.
  const ids = evalsFile.evals.map((item) => item.id);
  const duplicateIds = [...new Set(ids.filter((id, index) => ids.indexOf(id) !== index))];
  if (duplicateIds.length > 0) {
    addError(
      `${suite.skill}/${suite.suite}: evals.json reuses eval id ${duplicateIds.join(", ")}. ` +
        `Runs are written per id, so duplicates overwrite each other.`
    );
  }

  const missing = expected.filter((item) => !recorded.includes(item));
  const extra = recorded.filter((item) => !expected.includes(item));

  if (missing.length > 0 || extra.length > 0) {
    const details = [
      missing.length > 0 ? `not covered by the baseline: ${missing.join(", ")}` : null,
      extra.length > 0 ? `in the baseline but no longer defined: ${extra.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("; ");
    addError(
      `${suite.skill}/${suite.suite}: baseline does not match the current evals (${details}). ` +
        `Re-run the suite and promote it: ${promoteHint(suite)}`
    );
  }
}

async function validateSuite(suite) {
  const baselineDir = path.join(suite.suiteDir, "baselines");

  for (const file of REQUIRED_BASELINE_FILES) {
    try {
      await fs.access(path.join(baselineDir, file));
    } catch {
      addError(
        `${suite.skill}/${suite.suite}: missing baseline file ${file}. ` +
          `Run the suite, then promote it: ${promoteHint(suite)}`
      );
      return;
    }
  }

  const evalsFile = await readJsonFile(path.join(suite.suiteDir, "evals.json"), "evals.json");
  const currentMatrix = await readJsonFile(
    path.join(suite.suiteDir, "model-matrix.json"),
    "model-matrix.json"
  );
  const baseline = await readJsonFile(
    path.join(baselineDir, "baseline.json"),
    "baseline.json"
  );
  const baselineMatrix = await readJsonFile(
    path.join(baselineDir, "model-matrix.json"),
    "baseline model-matrix.json"
  );
  const benchmark = await readJsonFile(
    path.join(baselineDir, "aggregate-benchmark.json"),
    "baseline aggregate-benchmark.json"
  );

  if (!evalsFile || !currentMatrix || !baseline || !baselineMatrix || !benchmark) return;

  checkIdentity(suite, evalsFile, currentMatrix, baseline, benchmark);
  checkMatrix(suite, currentMatrix, baselineMatrix);
  checkEvalSet(suite, evalsFile, benchmark);
}

async function main() {
  const suites = await findEvalSuites();

  // Skills but no suites means a wrong working directory or removed suite files;
  // exiting 0 there would report success for having validated nothing.
  if (suites.length === 0) {
    const skills = await listDirectories(skillsRoot);
    if (skills.length > 0) {
      console.error(
        `Eval baseline validation failed:\n- found ${skills.length} skills under ` +
          `${relative(skillsRoot)} but no eval suites. Expected each suite to hold ` +
          `evals.json and model-matrix.json.`
      );
      process.exit(1);
    }
    console.log(`No skills found under ${relative(skillsRoot)}.`);
    process.exit(0);
  }

  for (const suite of suites) {
    await validateSuite(suite);
  }

  if (errors.length > 0) {
    console.error("Eval baseline validation failed:");
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    process.exit(1);
  }

  console.log(`Eval baseline validation passed for ${suites.length} suites.`);
}

await main();
