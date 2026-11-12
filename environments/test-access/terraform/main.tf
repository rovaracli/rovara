# The same resources as the CloudFormation template (../cloudformation/rovara-test-access.template.yaml): the test role, the delete-only cleanup role, the permissions
# boundary and the policies. The policies in ./policies are generated from the same source as the template's (scripts/test-access/build-artifacts.ts); do not edit them.
#
# There is no callback in Terraform. When it is applied, give Rovara the account id (Rovara asks for it after it sees no callback); the roles are named rovara-test-<connection id> and rovara-cleanup-<connection id>, which Rovara finds from it.
# The Region is the provider's: the boundary refuses every other Region.
# Apply with the provider's credentials of the account you are connecting. Rovara never asks for access keys.

data "aws_partition" "current" {}
data "aws_caller_identity" "current" {}
data "aws_region" "current" {}

locals {
  # The connection id is the last part of the external id; the roles are named from it, so Rovara can find them from the account id (as in the CloudFormation template).
  connection_id = element(split("-", var.external_id), 2)
  template_vars = {
    partition   = data.aws_partition.current.partition
    region      = data.aws_region.current.name
    account_id  = data.aws_caller_identity.current.account_id
    external_id = var.external_id
  }
}

# The whole fence: the test role, the cleanup role and every role a test run creates carry it, so a role a run creates is limited exactly as Rovara's own.
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

resource "aws_iam_policy" "cleanup" {
  name_prefix = "rovara-test-cleanup-"
  description = "What Rovara's cleanup role may do, inside the boundary: read and delete. Rovara test access."
  policy      = templatefile("${path.module}/policies/cleanup.json.tftpl", local.template_vars)
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
  name                 = "rovara-test-${local.connection_id}"
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

resource "aws_iam_role" "cleanup" {
  name                 = "rovara-cleanup-${local.connection_id}"
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
