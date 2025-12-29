/*
  Test script to compare Ollama enrichment results with GPT-4o baseline results.

  Usage:
    node src/testOllama.js --model llama3.1:8b
    node src/testOllama.js --model mistral:7b
*/
import fs from "fs/promises";
import { persistData, systemInstructions } from "./shared.js";

const OLLAMA_API = "http://localhost:11434/api/chat";

// Get model from command line or use default
function getModelFromArgs() {
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model" && args[i + 1]) {
      return args[i + 1];
    }
  }
  return "llama3.1:8b"; // Default
}

const MODEL = getModelFromArgs();

// Sanitize model name for filename
function sanitizeModelName(modelName) {
  return modelName.replace(/[^a-z0-9]/gi, "-").toLowerCase();
}

const systemMessage = systemInstructions.join(" ");

// Load GPT-4o enrichments
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

// Create user messages for Ollama
function createUserMessages(idToDescription) {
  return Object.keys(idToDescription).map((id) => ({
    id,
    description: idToDescription[id],
  }));
}

// Call Ollama API
async function callOllama(messages) {
  const userContent = JSON.stringify(messages);

  const response = await fetch(OLLAMA_API, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        {
          role: "system",
          content: systemMessage,
        },
        {
          role: "user",
          content: userContent,
        },
      ],
      stream: false,
      format: "json",
      temperature: 0,
    }),
  });

  if (!response.ok) {
    throw new Error(`Ollama API error: ${response.statusText}`);
  }

  const data = await response.json();
  return JSON.parse(data.message.content);
}

// Process in batches
async function getOllamaEnrichments(userMessages, batchSize = 5) {
  const batches = [];
  for (let i = 0; i < userMessages.length; i += batchSize) {
    batches.push(userMessages.slice(i, i + batchSize));
  }

  console.log(`Processing ${batches.length} batches...`);

  const results = [];
  for (let i = 0; i < batches.length; i++) {
    console.log(`Processing batch ${i + 1}/${batches.length}...`);
    try {
      const result = await callOllama(batches[i]);
      if (result.records) {
        results.push(...result.records);
      }
    } catch (err) {
      console.error(`Error in batch ${i + 1}:`, err.message);
    }
  }

  return results;
}

// Generate comparison report
function generateComparison(sample, ollamaResults) {
  const comparison = [];

  for (const gptRecord of sample) {
    const ollamaRecord = ollamaResults.find((r) => r.id === gptRecord.id);

    comparison.push({
      id: gptRecord.id,
      description: gptRecord.description,
      gpt4o: {
        humanReadableColor: gptRecord.humanReadableColor,
        cssReadableColors: gptRecord.cssReadableColors,
        pattern: gptRecord.pattern,
        texture: gptRecord.texture,
      },
      ollama: ollamaRecord
        ? {
            humanReadableColor: ollamaRecord.humanReadableColor,
            cssReadableColors: ollamaRecord.cssReadableColors,
            pattern: ollamaRecord.pattern,
            texture: ollamaRecord.texture,
          }
        : null,
    });
  }

  return comparison;
}

// Generate summary statistics
function generateSummary(comparison) {
  let exactMatches = 0;
  let ollamaBetter = 0;
  let gpt4oBetter = 0;
  let different = 0;
  let ollamaMissing = 0;

  const exampleDifferences = [];

  for (const record of comparison) {
    if (!record.ollama) {
      ollamaMissing++;
      continue;
    }

    const gptHasData =
      record.gpt4o.cssReadableColors ||
      record.gpt4o.pattern ||
      record.gpt4o.texture;
    const ollamaHasData =
      record.ollama.cssReadableColors ||
      record.ollama.pattern ||
      record.ollama.texture;

    // Exact match
    if (JSON.stringify(record.gpt4o) === JSON.stringify(record.ollama)) {
      exactMatches++;
    }
    // Ollama extracted data where GPT-4o didn't
    else if (!gptHasData && ollamaHasData) {
      ollamaBetter++;
      if (exampleDifferences.length < 10) {
        exampleDifferences.push(record);
      }
    }
    // GPT-4o extracted data where Ollama didn't
    else if (gptHasData && !ollamaHasData) {
      gpt4oBetter++;
      if (exampleDifferences.length < 10) {
        exampleDifferences.push(record);
      }
    }
    // Both extracted data but different
    else if (gptHasData && ollamaHasData) {
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
    ollamaBetter,
    gpt4oBetter,
    ollamaMissing,
    exampleDifferences,
  };
}

// Main execution
async function main() {
  try {
    const modelSlug = sanitizeModelName(MODEL);
    console.log(`\n=== Testing Model: ${MODEL} ===\n`);

    console.log("Loading GPT-4o enrichments...");
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

    console.log(`Starting Ollama enrichment with ${MODEL}...`);
    const startTime = Date.now();
    const ollamaResults = await getOllamaEnrichments(userMessages);
    const duration = Date.now() - startTime;

    console.log(`\nOllama enrichment completed in ${duration / 1000} seconds`);
    console.log(`Ollama returned ${ollamaResults.length} results`);

    console.log("Generating comparison...");
    const comparison = generateComparison(sample, ollamaResults);

    console.log("Generating summary statistics...");
    const summary = generateSummary(comparison);

    // Create comprehensive report
    const report = {
      metadata: {
        model: MODEL,
        timestamp: new Date().toISOString(),
        processingTime: duration,
        processingTimeSeconds: duration / 1000,
      },
      summary,
      comparison,
    };

    // Save model-specific files
    const enrichmentsFile = `./model_test_reports/ollama-${modelSlug}-enrichments.json`;
    const reportFile = `./model_test_reports/ollama-${modelSlug}-report.json`;

    console.log("Saving results...");
    await persistData(ollamaResults, enrichmentsFile);
    await persistData(report, reportFile);

    // Print console summary
    console.log("\n=== COMPARISON SUMMARY ===\n");
    console.log(`Model: ${MODEL}`);
    console.log(`Total records tested: ${summary.totalRecords}`);
    console.log(`Exact matches: ${summary.exactMatches}`);
    console.log(`Different extractions: ${summary.different}`);
    console.log(`Ollama found data GPT-4o missed: ${summary.ollamaBetter}`);
    console.log(`GPT-4o found data Ollama missed: ${summary.gpt4oBetter}`);
    console.log(`Ollama failed to return result: ${summary.ollamaMissing}`);
    console.log(
      `Processing time: ${
        summary.processingTimeSeconds || duration / 1000
      } seconds`,
    );

    console.log("\n=== FILES SAVED ===\n");
    console.log(`- ${enrichmentsFile} (Raw Ollama results)`);
    console.log(`- ${reportFile} (Full report with stats and comparison)`);
  } catch (err) {
    console.error("Error:", err);
    process.exit(1);
  }
}

main();
