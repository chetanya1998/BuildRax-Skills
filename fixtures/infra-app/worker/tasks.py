from celery import Celery
import psycopg2

app = Celery("tasks")
