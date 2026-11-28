from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

engine = create_engine("postgresql://localhost/app")
SessionLocal = sessionmaker(bind=engine)
