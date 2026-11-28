from celery import Celery

app = Celery("py")


@app.task
def send_receipt(item_id):
    return item_id
