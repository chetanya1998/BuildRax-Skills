resource "aws_db_instance" "main" {
  engine            = "postgres"
  engine_version    = "16.3"
  instance_class    = "db.t4g.small"
  allocated_storage = 20
  multi_az          = false
}

resource "aws_db_instance" "replica" {
  engine         = "postgres"
  instance_class = var.replica_class
}

resource "aws_elasticache_cluster" "cache" {
  engine          = "redis"
  node_type       = "cache.t4g.micro"
  num_cache_nodes = 1
}

resource "aws_s3_bucket" "uploads" {
  bucket = "acme-uploads"
}

resource "aws_ecs_task_definition" "api" {
  family = "api"
  cpu    = "512"
  memory = "1024"
  container_definitions = jsonencode([{ name = "api", image = "acme/api:latest" }])
}

resource "aws_ecs_service" "api" {
  name          = "api"
  desired_count = 2
}

resource "aws_lb" "main" {
  name = "main"
}
