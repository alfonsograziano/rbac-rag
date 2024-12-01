import Fastify from "fastify";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import { v4 as uuidv4 } from "uuid";
import fastifyMultipart from "@fastify/multipart";
import dotenv from "dotenv";
import path from "path";
import pg from "pg";
import pgvector from "pgvector/pg";
import openai from "openai";
import { splitTextIntoChunks } from "./utils.js";

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

dotenv.config();

const BUCKET_NAME = "alf-upload-bucket";

const app = Fastify({ logger: true });
const s3 = new S3Client({ region: "eu-west-1" });
const { Pool } = pg;

const openaiClient = new openai.OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.register(fastifyMultipart);

const pool = new Pool({
  user: "postgres_user",
  host: "localhost",
  database: "postgres_db",
  password: "postgres_psw",
  port: 5433,
});

await pool.connect();
await pool.query("CREATE EXTENSION IF NOT EXISTS vector"); // Ensure pgvector extension is created

// Register pgvector types for the PostgreSQL pool
pool.on("connect", (client) => {
  pgvector.registerType(client);
});

// Function to extract content from PDF
async function extractPdfContent(buffer) {
  try {
    const data = await pdfParse(Buffer.from(buffer));
    return data.text;
  } catch (err) {
    console.error("Failed to extract PDF content", err);
    throw new Error("Failed to extract PDF content");
  }
}

app.get("/health", async (req, reply) => {
  try {
    const result = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'"
    );
    return reply.send({ status: "ok", tables: result.rows });
  } catch (err) {
    console.log(err);
    return reply.status(500).send({ error: "Failed to query database" });
  }
});

app.post("/file/upload", async (request, reply) => {
  const data = await request.file();

  if (!data) {
    return reply.status(400).send({ error: "No file uploaded" });
  }

  const fileId = uuidv4();
  const extension = path.extname(data.filename);
  const s3Key = `uploads/${fileId}${extension}`;

  const fileBuffer = await data.toBuffer();
  let fileContent = "";

  if (extension === ".pdf") {
    fileContent = await extractPdfContent(fileBuffer);
  } else {
    fileContent = fileBuffer.toString("utf-8");
  }

  // Upload file to S3
  try {
    const uploadParams = {
      Bucket: BUCKET_NAME,
      Key: s3Key,
      Body: fileBuffer,
    };
    await s3.send(new PutObjectCommand(uploadParams));
  } catch (err) {
    console.error("Failed to upload file to S3", err);
    return reply.status(500).send({ error: "Failed to upload file to S3" });
  }

  // Split content into chunks and generate embeddings
  const chunks = splitTextIntoChunks(fileContent);

  try {
    const embeddingResponse = await openaiClient.embeddings.create({
      model: "text-embedding-ada-002",
      input: chunks,
    });

    const embeddings = embeddingResponse.data.map((item) => item.embedding);

    // Insert metadata for the file
    await pool.query(
      "INSERT INTO metadata (file_id, s3_uri, filename, permissions, uploaded_by) VALUES ($1, $2, $3, $4, $5)",
      [fileId, s3Key, data.filename, JSON.stringify([]), "unknown_user"]
    );

    // Insert each chunk with its embedding into vector_data
    for (let i = 0; i < chunks.length; i++) {
      const chunkId = uuidv4();
      const embeddingString = pgvector.toSql(embeddings[i]);

      await pool.query(
        "INSERT INTO vector_data (file_id, chunk_id, content, embedding) VALUES ($1, $2, $3, $4)",
        [fileId, chunkId, chunks[i], embeddingString]
      );
    }
  } catch (err) {
    console.error(
      "Failed to generate embeddings or insert data into PostgreSQL",
      err
    );
    return reply.status(500).send({ error: "Failed to process file content" });
  }

  return reply.send({ fileId, s3Key });
});

app.post("/search", async (request, reply) => {
  const { text, limit = 5 } = request.body;

  if (!text) {
    return reply.status(400).send({ error: "No search text provided" });
  }

  try {
    // Generate embedding for the input text
    const embeddingResponse = await openaiClient.embeddings.create({
      model: "text-embedding-ada-002",
      input: text,
    });

    const searchEmbedding = embeddingResponse.data[0].embedding;
    const embeddingString = pgvector.toSql(searchEmbedding);

    // Query the database for similar vectors
    const result = await pool.query(
      `
      SELECT file_id, content, embedding
      FROM vector_data
      ORDER BY embedding <-> $1
      LIMIT $2
      `,
      [embeddingString, limit]
    );

    return reply.send({ results: result.rows });
  } catch (err) {
    console.log(err);
    return reply.status(500).send({ error: "Failed to perform vector search" });
  }
});

app.post("/chat", async (request, reply) => {
  const { prompt } = request.body;

  if (!prompt) {
    return reply.status(400).send({ error: "No prompt provided" });
  }

  try {
    // Generate embedding for the input prompt
    const embeddingResponse = await openaiClient.embeddings.create({
      model: "text-embedding-ada-002",
      input: prompt,
    });

    const promptEmbedding = embeddingResponse.data[0].embedding;
    const embeddingString = pgvector.toSql(promptEmbedding);

    // Query the database for similar vectors to use as context
    const contextResult = await pool.query(
      `
      SELECT content
      FROM vector_data
      ORDER BY embedding <-> $1
      LIMIT 5
      `,
      [embeddingString]
    );

    const context = contextResult.rows.map((row) => row.content).join("\n");

    // Inject the context into the prompt
    const augmentedPrompt = `${context}\n\n${prompt}`;
    console.log("PROMPT: ", augmentedPrompt);
    // Call the LLM with the augmented prompt
    const completionResponse = await openaiClient.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: augmentedPrompt }],
      max_tokens: 300,
    });

    console.log(JSON.stringify(completionResponse, null, 2));
    const generatedText = completionResponse.choices[0].message.content;

    return reply.send({ response: generatedText });
  } catch (err) {
    console.log(err);
    return reply.status(500).send({ error: "Failed to generate response" });
  }
});

app.listen({ port: 8000 }, (err, address) => {
  if (err) {
    app.log.error(err);
    process.exit(1);
  }
  app.log.info(`Server listening at ${address}`);
});
