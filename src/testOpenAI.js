/*
  Test script to compare different OpenAI model results with GPT-4o baseline results.

  Usage:
    node src/testOpenAI.js --model gpt-4o-mini
    node src/testOpenAI.js --model gpt-3.5-turbo
*/
import fs from "fs/promises";
import { persistData, systemInstructions } from "./shared.js";
import OpenAIApi from "openai";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.log(
    "You need an OpenAI API Key set as a OPENAI_API_KEY env var. See .env.example",
  );
  process.exit(1);
}

const openai = new OpenAIApi({ apiKey });

// Get model from command line or use default
function getModelFromArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) {
      return args[i + 1];
    }
  }
  return "gpt-4o"; // Default
}

const MODEL = getModelFromArgs();

// Sanitize model name for filename
function sanitizeModelName(modelName) {
  return modelName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
}

const systemMessage = {
  role: "system",
  content: systemInstructions.join(" "),
};

// Load GPT-4o enrichments (baseline)
async function loadGPT4oEnrichments() {
  const data = await fs.readFile("./temp/openAIEnrichments.json", "utf8");
  return JSON.parse(data);
}

// Load collection data
async function loadCollection() {
  const data = await fs.readFile("./temp/collection.json", "utf8");
  return JSON.parse(data);
}

// Separate enriched vs not enriched
function categorizeEnrichments(enrichments) {
  const enriched = [];
  const notEnriched = [];

  for (const record of enrichments) {
    const hasData =
      record.cssReadableColors || record.pattern || record.texture;
    if (hasData) {
      enriched.push(record);
    } else {
      notEnriched.push(record);
    }
  }

  return { enriched, notEnriched };
}

// Sample records
function sampleRecords(enriched, notEnriched) {
  const sampledEnriched = enriched.slice(0, 10);
  const sampledNotEnriched = notEnriched.slice(0, 5);
  return [...sampledEnriched, ...sampledNotEnriched];
}

// Get descriptions from collection for sampled records
function getDescriptionsForSample(sample, collection) {
  const idToDescription = {};

  for (const record of sample) {
    const collectionRecord = collection.find(
      (c) => c.basic_information.id === parseInt(record.id),
    );

    if (collectionRecord) {
      const { formats } = collectionRecord.basic_information;
      const descriptions = formats
        .map((f) => {
          if (f.name.toLowerCase() !== "vinyl" || !f.text) {
            return null;
          }
          return f.text;
        })
        .filter((i) => i);

      if (descriptions.length > 0) {
        idToDescription[record.id] = descriptions.join(" and ");
      }
    }
  }

  return idToDescription;
}

// Create user messages
function createUserMessages(idToDescription) {
  return Object.keys(idToDescription).map((id) => {
    const description = idToDescription[id];
    return JSON.stringify({
      id,
      description,
    });
  });
}

// Call OpenAI API with test model
async function getOpenAIEnrichments(messages, batchSize = 15) {
  const requestsNeeded = Math.ceil(messages.length / batchSize);

  console.log(`Processing ${requestsNeeded} batches...`);
  const requests = Array.from(Array(requestsNeeded)).map((_, i) => {
    const start = i * batchSize;
    const end = start + batchSize;

    const requestConfig = {
      model: MODEL,
      temperature: 0,
      messages: [
        systemMessage,
        {
          role: "user",
          content: `[${messages.slice(start, end).join(",")}]`,
        },
      ],
      response_format: { type: "json_object" },
    };

    return openai.chat.completions.create(requestConfig);
  });

  const responses = await Promise.allSettled(requests);
  const errorResponses = responses
    .filter((r) => r.status === "rejected")
    .map((err) => ({
      ...err.reason.error,
    }));

  if (errorResponses.length) {
    console.error(errorResponses);
    console.error(
      `There were ${errorResponses.length} errors while interacting with the OpenAI API.`,
    );
    throw new Error("testOpenAI failed");
  }

  const enrichments = responses
    .map((res) => JSON.parse(res.value.choices[0].message.content).records)
    .flat();
  return enrichments;
}

// Generate comparison report
function generateComparison(sample, testResults, modelKey) {
  const comparison = [];

  for (const gptRecord of sample) {
    const testRecord = testResults.find((r) => r.id === gptRecord.id);

    const comparisonRecord = {
      id: gptRecord.id,
      description: gptRecord.description,
      gpt4o: {
        humanReadableColor: gptRecord.humanReadableColor,
        cssReadableColors: gptRecord.cssReadableColors,
        pattern: gptRecord.pattern,
        texture: gptRecord.texture,
      },
    };

    comparisonRecord[modelKey] = testRecord
      ? {
          humanReadableColor: testRecord.humanReadableColor,
          cssReadableColors: testRecord.cssReadableColors,
          pattern: testRecord.pattern,
          texture: testRecord.texture,
        }
      : null;

    comparison.push(comparisonRecord);
  }

  return comparison;
}

// Generate summary statistics
function generateSummary(comparison, modelKey) {
  let exactMatches = 0;
  let testModelBetter = 0;
  let gpt4oBetter = 0;
  let different = 0;
  let testModelMissing = 0;

  const exampleDifferences = [];

  for (const record of comparison) {
    if (!record[modelKey]) {
      testModelMissing++;
      continue;
    }

    const gptHasData =
      record.gpt4o.cssReadableColors ||
      record.gpt4o.pattern ||
      record.gpt4o.texture;
    const testHasData =
      record[modelKey].cssReadableColors ||
      record[modelKey].pattern ||
      record[modelKey].texture;

    // Exact match
    if (JSON.stringify(record.gpt4o) === JSON.stringify(record[modelKey])) {
      exactMatches++;
    }
    // Test model extracted data where GPT-4o didn't
    else if (!gptHasData && testHasData) {
      testModelBetter++;
      if (exampleDifferences.length < 10) {
        exampleDifferences.push(record);
      }
    }
    // GPT-4o extracted data where test model didn't
    else if (gptHasData && !testHasData) {
      gpt4oBetter++;
      if (exampleDifferences.length < 10) {
        exampleDifferences.push(record);
      }
    }
    // Both extracted data but different
    else if (gptHasData && testHasData) {
      different++;
      if (exampleDifferences.length < 10) {
        exampleDifferences.push(record);
      }
    }
  }

  return {
    totalRecords: comparison.length,
    exactMatches,
    different,
    testModelBetter,
    gpt4oBetter,
    testModelMissing,
    exampleDifferences,
  };
}

// Main execution
async function main() {
  try {
    const modelSlug = sanitizeModelName(MODEL);
    console.log(`\n=== Testing Model: ${MODEL} ===\n`);

    console.log("Loading GPT-4o enrichments (baseline)...");
    const gpt4oEnrichments = await loadGPT4oEnrichments();

    console.log("Loading collection data...");
    const collection = await loadCollection();

    console.log("Categorizing enrichments...");
    const { enriched, notEnriched } = categorizeEnrichments(gpt4oEnrichments);
    console.log(`Enriched records: ${enriched.length}`);
    console.log(`Not enriched records: ${notEnriched.length}`);

    console.log("Sampling records...");
    const sample = sampleRecords(enriched, notEnriched);
    console.log(`Sample size: ${sample.length}`);

    console.log("Getting descriptions from collection...");
    const idToDescription = getDescriptionsForSample(sample, collection);
    console.log(
      `Found descriptions for ${Object.keys(idToDescription).length} records`,
    );

    console.log("Creating user messages...");
    const userMessages = createUserMessages(idToDescription);

    console.log(`Starting OpenAI enrichment with ${MODEL}...`);
    const startTime = Date.now();
    const testResults = await getOpenAIEnrichments(userMessages);
    const duration = Date.now() - startTime;

    console.log(`\nEnrichment completed in ${duration / 1000} seconds`);
    console.log(`${MODEL} returned ${testResults.length} results`);

    console.log("Generating comparison...");
    const comparison = generateComparison(sample, testResults, modelSlug);

    console.log("Generating summary statistics...");
    const summary = generateSummary(comparison, modelSlug);

    // Create comprehensive report
    const report = {
      metadata: {
        model: MODEL,
        baselineModel: "gpt-4o",
        timestamp: new Date().toISOString(),
        processingTime: duration,
        processingTimeSeconds: duration / 1000,
      },
      summary,
      comparison,
    };

    // Save model-specific files
    const enrichmentsFile = `./model_test_reports/openai-${modelSlug}-enrichments.json`;
    const reportFile = `./model_test_reports/openai-${modelSlug}-report.json`;

    console.log("Saving results...");
    await persistData(testResults, enrichmentsFile);
    await persistData(report, reportFile);

    // Print console summary
    console.log("\n=== COMPARISON SUMMARY ===\n");
    console.log(`Test Model: ${MODEL}`);
    console.log(`Baseline: gpt-4o`);
    console.log(`Total records tested: ${summary.totalRecords}`);
    console.log(`Exact matches: ${summary.exactMatches}`);
    console.log(`Different extractions: ${summary.different}`);
    console.log(
      `${MODEL} found data GPT-4o missed: ${summary.testModelBetter}`,
    );
    console.log(`GPT-4o found data ${MODEL} missed: ${summary.gpt4oBetter}`);
    console.log(
      `${MODEL} failed to return result: ${summary.testModelMissing}`,
    );
    console.log(
      `Processing time: ${
        summary.processingTimeSeconds || duration / 1000
      } seconds`,
    );

    console.log("\n=== FILES SAVED ===\n");
    console.log(`- ${enrichmentsFile} (Raw ${MODEL} results)`);
    console.log(`- ${reportFile} (Full report with stats and comparison)`);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();
