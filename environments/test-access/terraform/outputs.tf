output "role_arn" {
  description = "The role Rovara assumes to run tests. Give it to Rovara with the account id."
  value       = aws_iam_role.test.arn
}

output "cleanup_role_arn" {
  description = "The role Rovara assumes to delete what a test run created."
  value       = aws_iam_role.cleanup.arn
}

output "account_id" {
  description = "The account id Rovara asks for."
  value       = data.aws_caller_identity.current.account_id
}

output "region" {
  description = "The one Region Rovara may use in this account."
  value       = data.aws_region.current.name
}

output "external_id" {
  description = "The external id of this connection."
  value       = var.external_id
}
