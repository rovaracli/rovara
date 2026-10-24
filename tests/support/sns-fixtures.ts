// Plan 4 Task 25: what the tests of the CloudWatch-through-SNS hook stand on. A TEST certificate authority and signing key (made once with openssl for these tests only: they sign
// nothing anywhere else and are not Amazon's), a fake network that serves certificates and the subscription confirmation by URL and records every request, and builders of signed SNS
// messages. The string to sign here is written out independently of the code under test, from AWS's "Verifying the signatures of Amazon SNS messages": the keys in byte-sort order,
// each as `<key>\n<value>\n`, `Subject` only when present.
import { createSign } from "node:crypto";

/** The test CA that issued the certificates below (the code under test does not chain-validate: the trust is the HTTPS fetch from an `sns.<region>.amazonaws.com` host). */
export const TEST_CA_PEM = `-----BEGIN CERTIFICATE-----
MIIDKjCCAhKgAwIBAgIUATSvP8psTLkpEH++7z9gcAVVz50wDQYJKoZIhvcNAQEL
BQAwNDEbMBkGA1UEAwwSUm92YXJhIFRlc3QgU05TIENBMRUwEwYDVQQKDAxSb3Zh
cmEgVGVzdHMwIBcNMjAwMTAxMDAwMDAwWhgPMjEyMDAxMDEwMDAwMDBaMDQxGzAZ
BgNVBAMMElJvdmFyYSBUZXN0IFNOUyBDQTEVMBMGA1UECgwMUm92YXJhIFRlc3Rz
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA13drnk0LP5jpILej4LYr
aTTXQtbOl0XJi5u984CuQ7M5eiIWXriZsrHTVM6r3+bLum76qI+SosKiHDixVAem
rrArdhq7dMLdFYlTXenoU4KizsP39SL32FOxr/Zn15rZ4MdAJ0h3vlyRDP76P7PF
rUwbxPX3qH/yg4+y7JFlvu1UMKcZjJ5gymUfGLlUHnFYrD5Ep9CzWG5U5uTvZ1h1
9sOdPTYGwZbgdVPty0ol//KH/y/UKyXCFEEWERZO58DOy4u/hnHvHbOP69U6WcUt
lWX9QgihjwvfDXCxJLPoQFeO+kR9DK/x66Gqt8VqIkv9fLMZ2C1v0v8tYPzz5OWl
IQIDAQABozIwMDAdBgNVHQ4EFgQUipSO6MsWp90k0XY+qQv+6NDwnMswDwYDVR0T
AQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAIaLWDZ8ZgxtI4DhmQv3Du3q1
wRQAOVaEh0/doP533lPOAULgioN9eySnSlhDHN+ydDaX0sxvA1JcFugaRxp3qRfC
49dxUM0wNSj3QE04/jW8NsB0QWqZRA4PFIR9dkbEwMqNoltA9o/b/KotFqa1v9kJ
1+oVjgyo+W80/StidttA440jDhKhiuonIsZhzL+Kcgh1NP50WHsts0ht7CN8H95u
2Z7eQityQRWm0OGhzL1GlusgbZuo7FKNNGczs5e3FypVfvHtlf9GJh3dVtLpjt7O
wH89Imj5XMiRqkIqFmrDyYEOZYJC2azthDZ5KjmFa8QhFt+KFT95jjF0YCQLDg==
-----END CERTIFICATE-----
`;
/** Valid 2020 to 2120, the public half of `TEST_SIGNING_KEY_PEM`. */
export const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIC/zCCAeegAwIBAgICA+kwDQYJKoZIhvcNAQELBQAwNDEbMBkGA1UEAwwSUm92
YXJhIFRlc3QgU05TIENBMRUwEwYDVQQKDAxSb3ZhcmEgVGVzdHMwIBcNMjAwMTAx
MDAwMDAwWhgPMjEyMDAxMDEwMDAwMDBaMDMxGjAYBgNVBAMMEXNucy5hbWF6b25h
d3MuY29tMRUwEwYDVQQKDAxSb3ZhcmEgVGVzdHMwggEiMA0GCSqGSIb3DQEBAQUA
A4IBDwAwggEKAoIBAQDLoZ+s08GCMyMrwZhGdn2huTfC3QSIC3OhTFAudZSwzd0E
fRTNKaVLo3O0FyHiDYaI9pzBIrO6SD1KdEsOxokUAe6eXjIYnQPRAjb8ZjJPYce4
7upwMdL/8XOENOtDsOiFxaBJ2pSh+yuTSn/3M6grLZKUEcDCVAwXTUsu9cKoG+gS
6a/KkSarshvn7BahP0NxZsVhFwp+K+GtHUHIWocVtjCKsAwsejaP2DyhEDf0uwCB
v5qxL4NQBIUlkgI1ZlPa0VPcVLnDe9ee2VvSW0rNvKiAQEEDVaKAW1eygg0jNU5A
N8VmqcNQnS8+Tr/U4kAuz64Uc9IHb/8TTxrItdaHAgMBAAGjGjAYMAkGA1UdEwQC
MAAwCwYDVR0PBAQDAgeAMA0GCSqGSIb3DQEBCwUAA4IBAQBMf89J4ilqgTtmAtsE
K43ZL7gyGz49oopOnVrF7sGOEKCHRr91iAQjhOS8g/mQ9hB3DL3LRrgHyW1QRrjt
dUJ3wPuv4zEw3YGshzanxjq0nJR6f9Z2gTUDNN+zokhHxL9pUPG2dLbYzoHtY+XR
haO8ISsCY82TDEqavdTsz9cFqdcSYpVjTTBSUF+Ww0KVv7tT+d+22wv/xisOm+Yd
H6X9E1oGgaQ0tp2YqN6dJxlaKfHTmbmpj1bSkfMsRMEe+8VdMh+F1NUARVsawFBY
6ygP3NCSboo3gEZYQvG70XQypEf72R65IO+YN2kRIT5HJBr9MrDRqFHjYuUpjTlv
83mu
-----END CERTIFICATE-----
`;
/** The same key, valid only in 2020. */
export const TEST_CERT_EXPIRED_PEM = `-----BEGIN CERTIFICATE-----
MIIC/TCCAeWgAwIBAgICA+owDQYJKoZIhvcNAQELBQAwNDEbMBkGA1UEAwwSUm92
YXJhIFRlc3QgU05TIENBMRUwEwYDVQQKDAxSb3ZhcmEgVGVzdHMwHhcNMjAwMTAx
MDAwMDAwWhcNMjEwMTAxMDAwMDAwWjAzMRowGAYDVQQDDBFzbnMuYW1hem9uYXdz
LmNvbTEVMBMGA1UECgwMUm92YXJhIFRlc3RzMIIBIjANBgkqhkiG9w0BAQEFAAOC
AQ8AMIIBCgKCAQEAy6GfrNPBgjMjK8GYRnZ9obk3wt0EiAtzoUxQLnWUsM3dBH0U
zSmlS6NztBch4g2GiPacwSKzukg9SnRLDsaJFAHunl4yGJ0D0QI2/GYyT2HHuO7q
cDHS//FzhDTrQ7DohcWgSdqUofsrk0p/9zOoKy2SlBHAwlQMF01LLvXCqBvoEumv
ypEmq7Ib5+wWoT9DcWbFYRcKfivhrR1ByFqHFbYwirAMLHo2j9g8oRA39LsAgb+a
sS+DUASFJZICNWZT2tFT3FS5w3vXntlb0ltKzbyogEBBA1WigFtXsoINIzVOQDfF
ZqnDUJ0vPk6/1OJALs+uFHPSB2//E08ayLXWhwIDAQABoxowGDAJBgNVHRMEAjAA
MAsGA1UdDwQEAwIHgDANBgkqhkiG9w0BAQsFAAOCAQEACe4A1refgKTrK80QtKkc
SZ+fufMQkflkkjpJYD/Vxa2LSMGJkp2iT+x0NAwvU8tWHF0/Zt7PZ0C25I2pgWw7
o3qt7qVsP+/8eFPLjYAO4fuKfQxC5LC3wV3Oizl4B9SLEGaUi3a3NXYAjx73LwI7
40MEf+0w/larmCFodTbrJaTOJ6HOR/qVmZbI9MBvDfQLG3y86N8HdkL9qBvLeO7w
Kl3MT8myTdhEG20EfSD1x1WdVqGf/0Gw7YQHPnMotB2sXX7Gq98WgtHqeMfkOYQZ
ZBx/1zwXdKvI5croY5TRzqgTTXmf+Nt9Sy7ete7+V/ZSsgrEvKsm3hPXfGK+IYM+
jw==
-----END CERTIFICATE-----
`;
/** The same key, valid only from 2100. */
export const TEST_CERT_FUTURE_PEM = `-----BEGIN CERTIFICATE-----
MIIDATCCAemgAwIBAgICA+swDQYJKoZIhvcNAQELBQAwNDEbMBkGA1UEAwwSUm92
YXJhIFRlc3QgU05TIENBMRUwEwYDVQQKDAxSb3ZhcmEgVGVzdHMwIhgPMjEwMDAx
MDEwMDAwMDBaGA8yMTEwMDEwMTAwMDAwMFowMzEaMBgGA1UEAwwRc25zLmFtYXpv
bmF3cy5jb20xFTATBgNVBAoMDFJvdmFyYSBUZXN0czCCASIwDQYJKoZIhvcNAQEB
BQADggEPADCCAQoCggEBAMuhn6zTwYIzIyvBmEZ2faG5N8LdBIgLc6FMUC51lLDN
3QR9FM0ppUujc7QXIeINhoj2nMEis7pIPUp0Sw7GiRQB7p5eMhidA9ECNvxmMk9h
x7ju6nAx0v/xc4Q060Ow6IXFoEnalKH7K5NKf/czqCstkpQRwMJUDBdNSy71wqgb
6BLpr8qRJquyG+fsFqE/Q3FmxWEXCn4r4a0dQchahxW2MIqwDCx6No/YPKEQN/S7
AIG/mrEvg1AEhSWSAjVmU9rRU9xUucN7157ZW9JbSs28qIBAQQNVooBbV7KCDSM1
TkA3xWapw1CdLz5Ov9TiQC7PrhRz0gdv/xNPGsi11ocCAwEAAaMaMBgwCQYDVR0T
BAIwADALBgNVHQ8EBAMCB4AwDQYJKoZIhvcNAQELBQADggEBAIZXEy+aaF5j622p
1qUUVwCQTKBxifOQqhGmE0Z0CVx4CxvPurQJZtBmNs2Jjhvc4QlxpaeBWHqGj2Vc
XwgkhhFy9ZmOut6tcapU812jLeXznGAO8Jw+9m/qDNna2E3K8qHKWy9PBOaDNK3p
6hh3YE73KXjvc42KohG66mIis/KaXn04zYNDE1TFTYuU9SqmCigl7+FwXH9X7VC3
goWKAeqP8gjb+hciND7LcTUWE+0v5YWJyiuYk1nFY+YxACQueh/JQZzo9a73q6X6
MPKp6DJWiLVMj1f2TRTbQF4hl3xjbD9EsvoAhqdgw0wIfJmiB19QUgR8XHrZ3KTk
uuSvlsg=
-----END CERTIFICATE-----
`;
/** TEST ONLY: the private key SNS would sign with in these tests. */
export const TEST_SIGNING_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDLoZ+s08GCMyMr
wZhGdn2huTfC3QSIC3OhTFAudZSwzd0EfRTNKaVLo3O0FyHiDYaI9pzBIrO6SD1K
dEsOxokUAe6eXjIYnQPRAjb8ZjJPYce47upwMdL/8XOENOtDsOiFxaBJ2pSh+yuT
Sn/3M6grLZKUEcDCVAwXTUsu9cKoG+gS6a/KkSarshvn7BahP0NxZsVhFwp+K+Gt
HUHIWocVtjCKsAwsejaP2DyhEDf0uwCBv5qxL4NQBIUlkgI1ZlPa0VPcVLnDe9ee
2VvSW0rNvKiAQEEDVaKAW1eygg0jNU5AN8VmqcNQnS8+Tr/U4kAuz64Uc9IHb/8T
TxrItdaHAgMBAAECggEAMIp+HD48PjO/ehJDoORlDVSwKKj0CBQmw7gD0xdfUwg3
2/aPK1r2lsHHdpIfFxpfTC3xbw69JjZLOgDf1Y1ZJuZRAfp1Wa2wN7Yd8mvQKWEn
MXvuccFGyZE+lrDgtjmpLB5Ql9pdnQFZQVq8h2qOd4B9FQPoXcqYOUPJHNAjz1uu
qgYlUMsyVC5AKUNBqg5imPUKpNfwmKUBl2TBaULPwMLD1FxF4h2YOS1q0IOz3Rpc
fDbfN9IhTT9JT5h5kvv8lWtihTrLtXOMVVIuhC+XOP0jwO9dU6uwjX5whB6quTM+
WFRtFKkGhcXMXBVH+BglshUxAtDePyKCY1jhDYNPBQKBgQDv0jzOSIyr89YOWpVj
vYB1D45f+CF4pJiX/OHuj3alQC97YLDO8k5LCI8hIza0A1OurUE3ky3vhBjNzbdg
hlstNA5FR81dgm5+5v+SiY8BToY+i+9GAjQzFeG3QV/4nhGqavyQ8ACPCmeGSYPU
hWurlTed98cDfkIec1DsFyPIOwKBgQDZXmESIMNAGvK8D6vHgc9UXrirg4uQztcm
MD0EH6z6gtr7iuOyjJBZHAqAn2zypV/J3neg+TqXstbv3uqEAARdpX4UFY9dwfQK
e32IQZgleDnVr94SvWeIlS/cuBnACGegmGqDu33Ah9lifuWUUNzDP7kx9V2ReJd9
JOaBX8VSJQKBgQCL44J8gW0s0CrIbKY/a8aGgfB2onJDwR8RaP0Q/rYiZnJL8Xax
AD4THob+uV+rWVVyyrUECeH9mHwvcBPLRhPhJkA8wUlVhkOV2oCxpXO5O2irC00i
9R4lvlnPX17v0qRTV9zDXnu09Ei22CMB0GGh0ISErId1ziwbPwCw9j51CQKBgAgh
89fNygBYAcTvgSnRvYQWlyozncEpO/t9yoqg9MPaqX7Hz4UapTvwRKRTUqwxa8gN
vsQTDxIl6szGtleB+KfYTUNLGzYSz6KkxCmY6qxcNy27ir+AvqLpkgTcDnqU1eu4
SCPtm+LcMlHxFX3bGKdldvRbjcinjmNsQgONJcDRAoGAMZIJ8WdVTLdGg5CZrtgZ
nSktXsDzCOdHsVFdtPIHOcIpMT/L20r1DVBGPiMnGkUe5w6EVnF9GMTjb03tRffQ
Vi63be0wuA3uS2BR/Oxat5ph1GSmKcR2/bYWqJ2hcbWI0QVVAwutOpEk/j3Xdbu1
tgeB1ua0rKHvcmvtMcui4u0=
-----END PRIVATE KEY-----
`;
/** TEST ONLY: a key the test certificate does not hold, for a forged signature. */
export const OTHER_SIGNING_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQDvJOTxT2If3NTr
6fgGeoian42iCQ+PK/hFyotrpiRYcc+nuOpF0KTHs+dpblb9Z7Hw7mZC2dqycxPC
FibSvoBVWyQNQDWbdWlMLks+tVdzoF7B0lSUnWfurj8jdoFhJawvGzQ4My+TjAX+
aC2P4Jfnn9v+ml/OPccGVzb4qVdzjFt/3teWav5jpYyik2oZJdV2bWJ+I8h4EwIE
aq/9SV3um0A0ZrPUTjNuKVpdk3VrX01/DNhS7NiLfHhQaBTLfJ2pNHZ98z/ZtryZ
LmSAvnhfNvhTQsLhftaUrFR7VomlpKr+I8DhlmxkhvmKGxiNH3YON4q9YkSsOGmd
Z1aJ8V3lAgMBAAECggEAKehkgYA4kR5dJsl92D7NZRFcW96sHholvC9CLvdyy5gI
PJtsXJczZTa68TAvqOEs3uycOY9dYqPFfN/uZkSRj0O1RegwbMGO1hWPxJm5TU83
g85E2bVa4wogkOmhwyE7sxaYmFep+PiTDVH62AmS/Tl3rz6k1urfD5alkL52T45c
tXqKLXBS9qxxqZCCEW8EfCFiUC/JagR7Ctf9+1don3DUfGRRQGOBnDxS6FbsDn1x
gbYWe4hTFZXVt+RZFhb40Fp/koaA+96qtfL5LHVBnsu1MIDpDzMvVL+OLS/Bc59v
+Mm2fy7w3ROl/mOGUHbEUsyg0X0kC2jltlXv5ircaQKBgQD9DUnwl1c8TO1yrU6R
0yVOohr4Poxz94NbnJYZdQmI26n7T/rdjdlMe1m42BycD10m6oRstT6JHw4YOfe+
DHnyCA2i02RYiQYXWuvRwQERtqzsLBXQz0fLey6pK8jZ8Hwi9xJKRI/F6AsmH+ev
maDlLFPQoW59XvwL/b2KFI2cCQKBgQDx7iBadKorqtuaQYsAQKw4c/PCjlGWL2/9
nu0PrFtRNQlmbzYelK3dh+yiF3hpZYPor/hlyMijYelwidtwdDauhR68ry0cFFdF
LKhcGCl2mEg/F9T7B4m8DbrKjQx3Na6M6lN/eeRfR3LswK6D9jqOmJxg1sfINA3y
4Xpe3Bkh/QKBgGXxjpIQRiKS0y3Zx8dTiroM8FSFzkuBsTec85M55SdvZyFJbUUI
OjxnjRO8bHoqblqZK9QniBPxoNn9sGKt4AqzV9r60ngga4XJKSuNV4LtVuimMfu3
JbNB4uBgNUAnc7saUhH9YPZXrvYi8FF70KfCndl0z3BObbfe9xbDhPERAoGBAO+S
QVOR59mqLiDI+t7bLDATErX8vOoeO6ZJNLOqmBsIjDB1vH/391xCd5/j4gds0X0g
lLgmZhj0ongg676mNmgHxvJN/juqIOmNWYMpIhYgoppn/S5AvrIMXoapukhqTlmY
yeqYR//Z/wJXo/llYYNHuMNkrR2h/pYfllBNYE35AoGAX1al2v7yhnjnugbcHnKD
BYoM2I9P0mI6296oL/a5Xg3ih9pQmlkftG0lEUarhjFCFPybfbUKmgDUdWShYNRl
OVNNDBbrvGOFVQiayoMxd2VHx3nlBR9rNxphfSx97+0ugNTZLUzUwM9HAMDCLnVe
zZDwvwX/WKliV5xXQQjV4+4=
-----END PRIVATE KEY-----
`;

export const SNS_ACCOUNT = "123456789012";
export const SNS_REGION = "us-east-1";
export const SNS_TOPIC_ARN = `arn:aws:sns:${SNS_REGION}:${SNS_ACCOUNT}:rovara-alarms`;
export const OTHER_ACCOUNT = "210987654321";
export const OTHER_TOPIC_ARN = `arn:aws:sns:${SNS_REGION}:${OTHER_ACCOUNT}:rovara-alarms`;
export const SNS_CERT_URL = `https://sns.${SNS_REGION}.amazonaws.com/SimpleNotificationService-0123456789abcdef0123456789abcdef.pem`;
export const SNS_SUBSCRIPTION_ARN = `${SNS_TOPIC_ARN}:2bcfbf39-05c3-41de-beaa-fcfcc21c8f55`;
export const SNS_TOKEN = "2336412f37fb687f5d51e6e2425c464de257d0a1";

export type SnsFields = Record<string, string | undefined>;

const NOTIFICATION_KEYS = ["Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type"] as const;
const CONFIRMATION_KEYS = ["Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type"] as const;

/** The string AWS says is signed: the type's keys in byte-sort order, each `<key>\n<value>\n`; `Subject` only when the message has one. */
export function awsStringToSign(fields: SnsFields): string {
  const keys = fields["Type"] === "Notification" ? NOTIFICATION_KEYS : CONFIRMATION_KEYS;
  return keys.filter((key) => fields[key] !== undefined).map((key) => `${key}\n${fields[key]!}\n`).join("");
}

export interface SignOptions {
  /** The key that signs (default: the test certificate's own). */
  key?: string;
  /** What `SignatureVersion` says (default "2"); the hash used follows `hash`, not this. */
  version?: string;
  hash?: "sha256" | "sha1";
  /** Fields to set after signing (a body changed after it was signed). */
  after?: SnsFields;
  certUrl?: string;
}

/** A message with its `Signature`, `SignatureVersion` and `SigningCertURL`, the way SNS sends it (JSON text). */
export function signSns(fields: SnsFields, options: SignOptions = {}): string {
  const signer = createSign(options.hash === "sha1" ? "RSA-SHA1" : "RSA-SHA256");
  signer.update(awsStringToSign(fields), "utf8");
  const Signature = signer.sign(options.key ?? TEST_SIGNING_KEY_PEM).toString("base64");
  const message: SnsFields = { ...fields, SignatureVersion: options.version ?? "2", Signature, SigningCertURL: options.certUrl ?? SNS_CERT_URL, ...options.after };
  return JSON.stringify(Object.fromEntries(Object.entries(message).filter(([, value]) => value !== undefined)));
}

export interface AlarmOver {
  name?: string;
  state?: string;
  account?: string;
  reason?: string;
  at?: string;
  namespace?: string;
  alarmArn?: string;
}

/** What CloudWatch puts in the `Message` of an alarm notification (AWS's alarm message format; `StateChangeTime` has the offset without a colon). */
export function alarmJson(over: AlarmOver = {}): string {
  const name = over.name ?? "HighCPU";
  return JSON.stringify({
    AlarmName: name, AlarmDescription: "CPU above 80", AWSAccountId: over.account ?? SNS_ACCOUNT, AlarmConfigurationUpdatedTimestamp: "2026-10-01T10:00:00.000+0000",
    NewStateValue: over.state ?? "ALARM", NewStateReason: over.reason ?? "Threshold Crossed: 1 datapoint [92.1] was greater than the threshold (80.0).", StateChangeTime: over.at ?? "2026-10-22T08:59:30.123+0000",
    Region: "US East (N. Virginia)", AlarmArn: over.alarmArn ?? `arn:aws:cloudwatch:${SNS_REGION}:${over.account ?? SNS_ACCOUNT}:alarm:${name}`, OldStateValue: "OK",
    Trigger: { MetricName: "CPUUtilization", Namespace: over.namespace ?? "AWS/EC2", StatisticType: "Statistic", Statistic: "AVERAGE", Unit: null, Dimensions: [{ value: "i-0abc", name: "InstanceId" }], Period: 300, EvaluationPeriods: 1, ComparisonOperator: "GreaterThanThreshold", Threshold: 80, TreatMissingData: "- TreatMissingData: missing", EvaluateLowSampleCountPercentile: "" },
  });
}

export function notificationFields(over: { messageId?: string; topicArn?: string; message?: string; subject?: string | null; timestamp?: string; alarm?: AlarmOver } = {}): SnsFields {
  return {
    Type: "Notification", MessageId: over.messageId ?? "da41e39f-ea4d-435a-b922-c6aae3915ebe", TopicArn: over.topicArn ?? SNS_TOPIC_ARN,
    ...(over.subject === null ? {} : { Subject: over.subject ?? 'ALARM: "HighCPU" in US East (N. Virginia)' }),
    Message: over.message ?? alarmJson(over.alarm), Timestamp: over.timestamp ?? "2026-10-22T08:59:31.000Z",
  };
}

/** The `SubscribeURL` SNS sends: the confirm action on the region's SNS host, with the topic and the token. */
export function subscribeUrl(over: { host?: string; topicArn?: string; token?: string; action?: string; scheme?: string; path?: string } = {}): string {
  const query = new URLSearchParams({ Action: over.action ?? "ConfirmSubscription", TopicArn: over.topicArn ?? SNS_TOPIC_ARN, Token: over.token ?? SNS_TOKEN });
  return `${over.scheme ?? "https"}://${over.host ?? `sns.${SNS_REGION}.amazonaws.com`}${over.path ?? "/"}?${query.toString().replaceAll("%3A", ":")}`;
}

export function confirmationFields(type: "SubscriptionConfirmation" | "UnsubscribeConfirmation" = "SubscriptionConfirmation", over: { messageId?: string; topicArn?: string; subscribeUrl?: string; token?: string; timestamp?: string } = {}): SnsFields {
  const topicArn = over.topicArn ?? SNS_TOPIC_ARN;
  return {
    Type: type, MessageId: over.messageId ?? "165545c9-2a5c-472c-8df2-7ff2be2b3b1b", Token: over.token ?? SNS_TOKEN, TopicArn: topicArn,
    Message: `You have chosen to subscribe to the topic ${topicArn}.\nTo confirm the subscription, visit the SubscribeURL included in this message.`,
    SubscribeURL: over.subscribeUrl ?? subscribeUrl({ topicArn, ...(over.token === undefined ? {} : { token: over.token }) }), Timestamp: over.timestamp ?? "2026-10-22T08:59:00.000Z",
  };
}

/** What SNS answers a visit to the `SubscribeURL`: the subscription's ARN in XML. */
export const confirmXml = (arn: string = SNS_SUBSCRIPTION_ARN): string => `<ConfirmSubscriptionResponse xmlns="http://sns.amazonaws.com/doc/2010-03-31/"><ConfirmSubscriptionResult><SubscriptionArn>${arn}</SubscriptionArn></ConfirmSubscriptionResult><ResponseMetadata><RequestId>5c3b0a91-0d5c-5f2c-8d1c-a5e6c7ad1f6a</RequestId></ResponseMetadata></ConfirmSubscriptionResponse>`;

/** The network the code under test may use: certificates by URL and the confirmation by URL. Every request is recorded; anything else is a connection failure. */
export class FakeSnsNetwork {
  readonly certs = new Map<string, string>([[SNS_CERT_URL, TEST_CERT_PEM]]);
  readonly requests: Array<{ url: string; method: string }> = [];
  /** What a visit to a confirmation URL answers (default: success with the subscription ARN). */
  confirm: { status: number; body: string } | "fail" = { status: 200, body: confirmXml() };
  /** Answers every certificate request with this status, when set. */
  certStatus: number | undefined;
  readonly fetch: typeof fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    this.requests.push({ url, method: init?.method ?? "GET" });
    if (url.includes("Action=ConfirmSubscription")) {
      if (this.confirm === "fail") throw new TypeError("fetch failed");
      return new Response(this.confirm.body, { status: this.confirm.status });
    }
    if (this.certStatus !== undefined) return new Response("no", { status: this.certStatus });
    const pem = this.certs.get(url);
    return pem === undefined ? new Response("<UnknownOperationException/>", { status: 404 }) : new Response(pem, { status: 200, headers: { "content-type": "application/x-pem-file" } });
  };
  get certRequests(): string[] { return this.requests.filter((request) => request.url.endsWith(".pem")).map((request) => request.url); }
  get confirmRequests(): string[] { return this.requests.filter((request) => request.url.includes("Action=ConfirmSubscription")).map((request) => request.url); }
}
