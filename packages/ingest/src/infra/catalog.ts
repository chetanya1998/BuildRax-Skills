/** What a piece of infrastructure is, independent of where we saw it. */
export type InfraKind =
  | "compute"
  | "hosting"
  | "database"
  | "cache"
  | "queue"
  | "storage"
  | "cdn"
  | "email"
  | "payments"
  | "llm"
  | "messaging"
  | "search"
  | "auth";

export interface ServiceDef {
  kind: InfraKind;
  /** Stable key: node id is `<kind>:<key>`. */
  key: string;
  label: string;
  provider?: string;
  engine?: string;
}

const d = (
  kind: InfraKind,
  key: string,
  label: string,
  provider?: string,
  engine?: string,
): ServiceDef => ({
  kind,
  key,
  label,
  provider,
  engine: engine ?? key,
});

const POSTGRES = d("database", "postgres", "PostgreSQL");
const MYSQL = d("database", "mysql", "MySQL");
const MONGO = d("database", "mongodb", "MongoDB");
const REDIS = d("cache", "redis", "Redis");
const S3 = d("storage", "s3", "Amazon S3", "aws");

/**
 * SDK / client libraries (npm and PyPI names, lower-case) and the service they talk to. Only
 * libraries that clearly imply one service are listed; generic SDKs (e.g. boto3) are not guessed.
 */
export const SDK_SERVICES: Record<string, ServiceDef> = {
  pg: POSTGRES,
  postgres: POSTGRES,
  "pg-promise": POSTGRES,
  psycopg2: POSTGRES,
  "psycopg2-binary": POSTGRES,
  psycopg: POSTGRES,
  asyncpg: POSTGRES,
  "@neondatabase/serverless": d("database", "postgres", "PostgreSQL", "neon", "postgres"),
  mysql: MYSQL,
  mysql2: MYSQL,
  pymysql: MYSQL,
  mysqlclient: MYSQL,
  mongodb: MONGO,
  mongoose: MONGO,
  pymongo: MONGO,
  motor: MONGO,
  "@aws-sdk/client-dynamodb": d("database", "dynamodb", "Amazon DynamoDB", "aws"),
  "@supabase/supabase-js": d("database", "supabase", "Supabase", "supabase", "postgres"),
  supabase: d("database", "supabase", "Supabase", "supabase", "postgres"),
  "firebase-admin": d("database", "firestore", "Cloud Firestore", "google"),
  ioredis: REDIS,
  redis: REDIS,
  "@redis/client": REDIS,
  memjs: d("cache", "memcached", "Memcached"),
  pymemcache: d("cache", "memcached", "Memcached"),
  bullmq: d("queue", "bullmq", "BullMQ (Redis)", undefined, "redis"),
  bull: d("queue", "bullmq", "BullMQ (Redis)", undefined, "redis"),
  amqplib: d("queue", "rabbitmq", "RabbitMQ"),
  pika: d("queue", "rabbitmq", "RabbitMQ"),
  kafkajs: d("queue", "kafka", "Apache Kafka"),
  "kafka-python": d("queue", "kafka", "Apache Kafka"),
  "confluent-kafka": d("queue", "kafka", "Apache Kafka"),
  "@aws-sdk/client-sqs": d("queue", "sqs", "Amazon SQS", "aws"),
  celery: d("queue", "celery", "Celery workers"),
  "@aws-sdk/client-s3": S3,
  "@google-cloud/storage": d("storage", "gcs", "Google Cloud Storage", "google"),
  "google-cloud-storage": d("storage", "gcs", "Google Cloud Storage", "google"),
  "@azure/storage-blob": d("storage", "azure-blob", "Azure Blob Storage", "azure"),
  "azure-storage-blob": d("storage", "azure-blob", "Azure Blob Storage", "azure"),
  "@aws-sdk/client-ses": d("email", "ses", "Amazon SES", "aws"),
  "@aws-sdk/client-sesv2": d("email", "ses", "Amazon SES", "aws"),
  "@sendgrid/mail": d("email", "sendgrid", "SendGrid", "twilio"),
  sendgrid: d("email", "sendgrid", "SendGrid", "twilio"),
  resend: d("email", "resend", "Resend", "resend"),
  postmark: d("email", "postmark", "Postmark", "postmark"),
  "mailgun.js": d("email", "mailgun", "Mailgun", "mailgun"),
  stripe: d("payments", "stripe", "Stripe", "stripe"),
  razorpay: d("payments", "razorpay", "Razorpay", "razorpay"),
  openai: d("llm", "openai", "OpenAI API", "openai"),
  "@anthropic-ai/sdk": d("llm", "anthropic", "Anthropic API", "anthropic"),
  anthropic: d("llm", "anthropic", "Anthropic API", "anthropic"),
  "@google/generative-ai": d("llm", "gemini", "Google Gemini API", "google"),
  "@google/genai": d("llm", "gemini", "Google Gemini API", "google"),
  "google-generativeai": d("llm", "gemini", "Google Gemini API", "google"),
  "@aws-sdk/client-bedrock-runtime": d("llm", "bedrock", "Amazon Bedrock", "aws"),
  twilio: d("messaging", "twilio", "Twilio", "twilio"),
  "@elastic/elasticsearch": d("search", "elasticsearch", "Elasticsearch"),
  elasticsearch: d("search", "elasticsearch", "Elasticsearch"),
  "@opensearch-project/opensearch": d("search", "opensearch", "OpenSearch"),
  "opensearch-py": d("search", "opensearch", "OpenSearch"),
  algoliasearch: d("search", "algolia", "Algolia", "algolia"),
  meilisearch: d("search", "meilisearch", "Meilisearch"),
  auth0: d("auth", "auth0", "Auth0", "okta"),
  "@auth0/nextjs-auth0": d("auth", "auth0", "Auth0", "okta"),
  "@clerk/nextjs": d("auth", "clerk", "Clerk", "clerk"),
  "@clerk/clerk-sdk-node": d("auth", "clerk", "Clerk", "clerk"),
};

/** Docker images (repository name, without registry/tag) that are infrastructure, not app code. */
export const IMAGE_SERVICES: { match: RegExp; def: ServiceDef }[] = [
  { match: /^(library\/)?postgres$|postgis/, def: POSTGRES },
  { match: /^(library\/)?(mysql|mariadb)$/, def: MYSQL },
  { match: /^(library\/)?mongo$/, def: MONGO },
  { match: /^(library\/)?redis$|redis-stack/, def: REDIS },
  { match: /valkey/, def: d("cache", "valkey", "Valkey") },
  { match: /^(library\/)?memcached$/, def: d("cache", "memcached", "Memcached") },
  { match: /^(library\/)?rabbitmq$/, def: d("queue", "rabbitmq", "RabbitMQ") },
  { match: /kafka/, def: d("queue", "kafka", "Apache Kafka") },
  { match: /elasticsearch/, def: d("search", "elasticsearch", "Elasticsearch") },
  { match: /opensearch/, def: d("search", "opensearch", "OpenSearch") },
  { match: /meilisearch/, def: d("search", "meilisearch", "Meilisearch") },
  { match: /minio/, def: d("storage", "s3", "S3-compatible storage (MinIO)", undefined, "s3") },
];

/** Terraform resource types → service, and which attributes carry size information. */
export const TF_RESOURCES: Record<string, ServiceDef> = {
  aws_db_instance: d("database", "postgres", "Amazon RDS", "aws"),
  aws_rds_cluster: d("database", "postgres", "Amazon Aurora", "aws"),
  aws_elasticache_cluster: d("cache", "redis", "Amazon ElastiCache", "aws"),
  aws_elasticache_replication_group: d("cache", "redis", "Amazon ElastiCache", "aws"),
  aws_dynamodb_table: d("database", "dynamodb", "Amazon DynamoDB", "aws"),
  aws_s3_bucket: S3,
  aws_sqs_queue: d("queue", "sqs", "Amazon SQS", "aws"),
  aws_sns_topic: d("messaging", "sns", "Amazon SNS", "aws"),
  aws_cloudfront_distribution: d("cdn", "cloudfront", "Amazon CloudFront", "aws"),
  aws_lb: d("compute", "load-balancer", "Application Load Balancer", "aws", "alb"),
  aws_alb: d("compute", "load-balancer", "Application Load Balancer", "aws", "alb"),
  aws_opensearch_domain: d("search", "opensearch", "Amazon OpenSearch", "aws"),
  aws_elasticsearch_domain: d("search", "opensearch", "Amazon OpenSearch", "aws"),
  aws_cognito_user_pool: d("auth", "cognito", "Amazon Cognito", "aws"),
  aws_ses_domain_identity: d("email", "ses", "Amazon SES", "aws"),
  aws_sesv2_email_identity: d("email", "ses", "Amazon SES", "aws"),
  google_sql_database_instance: d("database", "postgres", "Cloud SQL", "google"),
  google_storage_bucket: d("storage", "gcs", "Google Cloud Storage", "google"),
  google_redis_instance: d("cache", "redis", "Memorystore for Redis", "google"),
  azurerm_postgresql_flexible_server: d(
    "database",
    "postgres",
    "Azure Database for PostgreSQL",
    "azure",
  ),
  azurerm_redis_cache: d("cache", "redis", "Azure Cache for Redis", "azure"),
  azurerm_storage_account: d("storage", "azure-blob", "Azure Storage", "azure"),
};

/** Terraform compute resources: each becomes its own compute node. */
export const TF_COMPUTE: Record<string, { label: string; provider: string; engine: string }> = {
  aws_ecs_service: { label: "ECS service", provider: "aws", engine: "ecs" },
  aws_lambda_function: { label: "Lambda function", provider: "aws", engine: "lambda" },
  aws_instance: { label: "EC2 instance", provider: "aws", engine: "ec2" },
  aws_apprunner_service: { label: "App Runner service", provider: "aws", engine: "apprunner" },
  google_cloud_run_service: { label: "Cloud Run service", provider: "google", engine: "cloud-run" },
  google_cloud_run_v2_service: {
    label: "Cloud Run service",
    provider: "google",
    engine: "cloud-run",
  },
  azurerm_linux_web_app: { label: "Azure App Service", provider: "azure", engine: "app-service" },
};

/** Environment variable *names* (never values) that hint at a service. Weak evidence only. */
export const ENV_HINTS: { match: RegExp; def: ServiceDef }[] = [
  { match: /^(DATABASE_URL|POSTGRES_|PG(HOST|USER|DATABASE|PASSWORD))/, def: POSTGRES },
  { match: /^MYSQL_/, def: MYSQL },
  { match: /^MONGO(DB)?_/, def: MONGO },
  { match: /^REDIS_/, def: REDIS },
  { match: /^(AWS_)?S3_/, def: S3 },
  { match: /^STRIPE_/, def: d("payments", "stripe", "Stripe", "stripe") },
  { match: /^OPENAI_/, def: d("llm", "openai", "OpenAI API", "openai") },
  { match: /^ANTHROPIC_/, def: d("llm", "anthropic", "Anthropic API", "anthropic") },
  { match: /^SENDGRID_/, def: d("email", "sendgrid", "SendGrid", "twilio") },
  { match: /^RESEND_/, def: d("email", "resend", "Resend", "resend") },
  { match: /^TWILIO_/, def: d("messaging", "twilio", "Twilio", "twilio") },
];

/** Repository name of a Docker image reference: `docker.io/library/postgres:16-alpine` → `postgres`. */
export function imageRepo(image: string): { repo: string; tag?: string } {
  const noDigest = image.split("@")[0]!;
  const lastSlash = noDigest.lastIndexOf("/");
  const colon = noDigest.indexOf(":", lastSlash + 1);
  const name = colon >= 0 ? noDigest.slice(0, colon) : noDigest;
  const tag = colon >= 0 ? noDigest.slice(colon + 1) : undefined;
  const parts = name.split("/");
  // Drop a registry host (has a dot or a port) at the front.
  if (parts.length > 1 && /[.:]/.test(parts[0]!)) parts.shift();
  return { repo: parts.join("/").toLowerCase(), tag };
}

export function serviceForImage(image: string): ServiceDef | undefined {
  const { repo } = imageRepo(image);
  return IMAGE_SERVICES.find((s) => s.match.test(repo))?.def;
}
