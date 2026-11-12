# The same resources as the CloudFormation template (../cloudformation/rovara-test-access.template.yaml): the test role, the delete-only cleanup role, the permissions
# boundary and the policies. The policies in ./policies are generated from the same source as the template's (scripts/test-access/build-artifacts.ts); do not edit them.
#
# There is no callback in Terraform. When it is applied, give Rovara the account id and the role_arn output (Rovara asks for them after it sees no callback).
# The Region is the provider's: the boundary refuses every other Region.
# Apply with the provider's credentials of the account you are connecting. Rovara never asks for access keys.

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  template_vars = {
    partition   = data.aws_partition.current.partition
    region      = data.aws_region.current.name
    account_id  = data.aws_caller_identity.current.account_id
    external_id = var.external_id
  }
  guard_files         = sort(tolist(fileset("${path.module}/policies", "guard-*.json.tftpl")))
  cleanup_guard_files = sort(tolist(fileset("${path.module}/policies", "cleanup-guard-*.json.tftpl")))
}

# The ceiling: the test role, the cleanup role and every role a test run creates carry it.
resource "aws_iam_policy" "boundary" {
  name        = "rovara-test-boundary-${var.external_id}"
  description = "Limits Rovara's test role and every role a test run creates. Rovara test access."
  policy      = templatefile("${path.module}/policies/boundary.json.tftpl", local.template_vars)
  tags        = var.tags
}

resource "aws_iam_policy" "access" {
  name_prefix = "rovara-test-access-"
  description = "What Rovara's test role may do, inside the boundary. Rovara test access."
  policy      = templatefile("${path.module}/policies/access.json.tftpl", local.template_vars)
  tags        = var.tags
}

resource "aws_iam_policy" "guard" {
  for_each    = toset(local.guard_files)
  name_prefix = "rovara-test-guard-"
  description = "Per-action limits of the test role: it creates only with the run tag and changes only what carries it. Rovara test access."
  policy      = templatefile("${path.module}/policies/${each.value}", local.template_vars)
  tags        = var.tags
}

resource "aws_iam_policy" "cleanup" {
  name_prefix = "rovara-test-cleanup-"
  description = "What Rovara's cleanup role may do, inside the boundary: read and delete. Rovara test access."
  policy      = templatefile("${path.module}/policies/cleanup.json.tftpl", local.template_vars)
  tags        = var.tags
}

resource "aws_iam_policy" "cleanup_guard" {
  for_each    = toset(local.cleanup_guard_files)
  name_prefix = "rovara-test-cleanup-guard-"
  description = "Per-action limits of the cleanup role: it deletes only what carries the run tag. Rovara test access."
  policy      = templatefile("${path.module}/policies/${each.value}", local.template_vars)
  tags        = var.tags
}

# Only Rovara's role, only with the external id; the session must carry the run tag (8 characters) and no other.
data "aws_iam_policy_document" "trust" {
  statement {
    sid     = "RovaraAssumesWithExternalId"
    effect  = "Allow"
    actions = ["sts:AssumeRole"]

    principals {
      type        = "AWS"
      identifiers = [var.rovara_principal_arn]
    }

    condition {
      test     = "StringEquals"
      variable = "sts:ExternalId"
      values   = [var.external_id]
    }
  }

  statement {
    sid     = "RovaraTagsTheSession"
    effect  = "Allow"
    actions = ["sts:TagSession"]

    principals {
      type        = "AWS"
      identifiers = [var.rovara_principal_arn]
    }

    condition {
      test     = "ForAllValues:StringEquals"
      variable = "aws:TagKeys"
      values   = ["rovara-run"]
    }

    condition {
      test     = "StringLike"
      variable = "aws:RequestTag/rovara-run"
      values   = ["????????"]
    }
  }
}

resource "aws_iam_role" "test" {
  name_prefix          = "rovara-test-"
  description          = "Assumed by Rovara to run tests in this account. Rovara test access."
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  permissions_boundary = aws_iam_policy.boundary.arn
  max_session_duration = 3600
  tags                 = var.tags
}

resource "aws_iam_role_policy_attachment" "test_access" {
  role       = aws_iam_role.test.name
  policy_arn = aws_iam_policy.access.arn
}

resource "aws_iam_role_policy_attachment" "test_guard" {
  for_each   = aws_iam_policy.guard
  role       = aws_iam_role.test.name
  policy_arn = each.value.arn
}

resource "aws_iam_role" "cleanup" {
  name_prefix          = "rovara-cleanup-"
  description          = "Assumed by Rovara to delete what a test run created. It cannot create or change anything. Rovara test access."
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  permissions_boundary = aws_iam_policy.boundary.arn
  max_session_duration = 3600
  tags                 = var.tags
}

resource "aws_iam_role_policy_attachment" "cleanup_access" {
  role       = aws_iam_role.cleanup.name
  policy_arn = aws_iam_policy.cleanup.arn
}

resource "aws_iam_role_policy_attachment" "cleanup_guard" {
  for_each   = aws_iam_policy.cleanup_guard
  role       = aws_iam_role.cleanup.name
  policy_arn = each.value.arn
}
