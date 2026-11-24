import { S3Client } from "@aws-sdk/client-s3";
import sgMail from "@sendgrid/mail";

export const upload = () => [S3Client, sgMail];
