variable "external_id" {
  description = "The external id of the connection, shown by Rovara (rovara-org_...-conn_...). The test role can be assumed only by a caller that presents it."
  type        = string

  validation {
    condition     = can(regex("^rovara-org_[0-9a-z]{20}-conn_[0-9a-z]{20}$", var.external_id))
    error_message = "The external id looks like rovara-org_<20 characters>-conn_<20 characters>. Copy it from Rovara."
  }
}

variable "rovara_principal_arn" {
  description = "The ARN of the Rovara role that assumes the test role, shown by Rovara."
  type        = string

  validation {
    condition     = can(regex("^arn:aws:iam::[0-9]{12}:role/[A-Za-z0-9+=,.@_/-]{1,512}$", var.rovara_principal_arn))
    error_message = "This is an IAM role ARN, as shown by Rovara."
  }
}

variable "tags" {
  description = "Tags for the roles and policies. Do not use the key rovara-run: it belongs to the test runs."
  type        = map(string)
  default     = {}

  validation {
    condition     = !contains(keys(var.tags), "rovara-run")
    error_message = "The tag key rovara-run is reserved for Rovara's test runs."
  }
}
