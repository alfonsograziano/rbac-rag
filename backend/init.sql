-- Metadata Table
CREATE TABLE metadata (
    file_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    s3_uri TEXT NOT NULL,
    filename TEXT NOT NULL,
    permissions JSONB NOT NULL,
    uploaded_by TEXT NOT NULL,
    upload_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Vector Table for storing document chunks and their embeddings
CREATE TABLE vector_data (
    chunk_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    file_id UUID REFERENCES metadata(file_id) ON DELETE CASCADE,
    content TEXT NOT NULL,
    embedding VECTOR(1536) -- Assuming the vector size is 1536, you can adjust accordingly
);

-- Index for fast vector similarity search
CREATE INDEX vector_data_embedding_idx ON vector_data USING ivfflat (embedding);