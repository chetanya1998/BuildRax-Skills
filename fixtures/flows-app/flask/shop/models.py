from django.db import models


class Product(models.Model):
    sku = models.CharField(max_length=32, primary_key=True)
    title = models.CharField(max_length=200)


class Review(models.Model):
    product = models.ForeignKey(Product, on_delete=models.CASCADE)
    stars = models.IntegerField()
