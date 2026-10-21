/**
 * The pinned time-stamp roots, embedded because the package is compiled with plain `tsc` and a .pem file
 * next to the sources would not reach dist/. These strings are byte-for-byte the files in ./trust/ (a test
 * compares them, and compares each certificate with the fingerprint pinned in its header comment).
 */
export const DIGICERT_ROOT_PEM = `# DigiCert Trusted Root G4 (self-signed), the root of the DigiCert timestamp chain.
# Subject: C=US, O=DigiCert Inc, OU=www.digicert.com, CN=DigiCert Trusted Root G4
# SHA-256 fingerprint: 55:2F:7B:DC:F1:A7:AF:9E:6C:E6:72:01:7F:4F:12:AB:F7:72:40:C7:8E:76:1A:C2:03:D1:D9:D2:0A:C8:99:88
# Valid: 2013-08-01 to 2038-01-15
# Published list: https://knowledge.digicert.com/general-information/digicert-trusted-root-authority-certificates
#   (formerly https://www.digicert.com/kb/digicert-root-certificates.htm), "Other root certificates".
# Download: https://cacerts.digicert.com/DigiCertTrustedRootG4.crt.pem
# Cross-check: the chain in a live token from http://timestamp.digicert.com on 2026-10-20 ends at this
#   subject (the token also carries a copy cross-signed by DigiCert Assured ID Root CA, which is not trusted here).
# Pinned 2026-10-20. Do not edit the certificate; replace it only after re-checking the published list.
-----BEGIN CERTIFICATE-----
MIIFkDCCA3igAwIBAgIQBZsbV56OITLiOQe9p3d1XDANBgkqhkiG9w0BAQwFADBi
MQswCQYDVQQGEwJVUzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3
d3cuZGlnaWNlcnQuY29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3Qg
RzQwHhcNMTMwODAxMTIwMDAwWhcNMzgwMTE1MTIwMDAwWjBiMQswCQYDVQQGEwJV
UzEVMBMGA1UEChMMRGlnaUNlcnQgSW5jMRkwFwYDVQQLExB3d3cuZGlnaWNlcnQu
Y29tMSEwHwYDVQQDExhEaWdpQ2VydCBUcnVzdGVkIFJvb3QgRzQwggIiMA0GCSqG
SIb3DQEBAQUAA4ICDwAwggIKAoICAQC/5pBzaN675F1KPDAiMGkz7MKnJS7JIT3y
ithZwuEppz1Yq3aaza57G4QNxDAf8xukOBbrVsaXbR2rsnnyyhHS5F/WBTxSD1If
xp4VpX6+n6lXFllVcq9ok3DCsrp1mWpzMpTREEQQLt+C8weE5nQ7bXHiLQwb7iDV
ySAdYyktzuxeTsiT+CFhmzTrBcZe7FsavOvJz82sNEBfsXpm7nfISKhmV1efVFiO
DCu3T6cw2Vbuyntd463JT17lNecxy9qTXtyOj4DatpGYQJB5w3jHtrHEtWoYOAMQ
jdjUN6QuBX2I9YI+EJFwq1WCQTLX2wRzKm6RAXwhTNS8rhsDdV14Ztk6MUSaM0C/
CNdaSaTC5qmgZ92kJ7yhTzm1EVgX9yRcRo9k98FpiHaYdj1ZXUJ2h4mXaXpI8OCi
EhtmmnTK3kse5w5jrubU75KSOp493ADkRSWJtppEGSt+wJS00mFt6zPZxd9LBADM
fRyVw4/3IbKyEbe7f/LVjHAsQWCqsWMYRJUadmJ+9oCw++hkpjPRiQfhvbfmQ6QY
uKZ3AeEPlAwhHbJUKSWJbOUOUlFHdL4mrLZBdd56rF+NP8m800ERElvlEFDrMcXK
chYiCd98THU/Y+whX8QgUWtvsauGi0/C1kVfnSD8oR7FwI+isX4KJpn15GkvmB0t
9dmpsh3lGwIDAQABo0IwQDAPBgNVHRMBAf8EBTADAQH/MA4GA1UdDwEB/wQEAwIB
hjAdBgNVHQ4EFgQU7NfjgtJxXWRM3y5nP+e6mK4cD08wDQYJKoZIhvcNAQEMBQAD
ggIBALth2X2pbL4XxJEbw6GiAI3jZGgPVs93rnD5/ZpKmbnJeFwMDF/k5hQpVgs2
SV1EY+CtnJYYZhsjDT156W1r1lT40jzBQ0CuHVD1UvyQO7uYmWlrx8GnqGikJ9yd
+SeuMIW59mdNOj6PWTkiU0TryF0Dyu1Qen1iIQqAyHNm0aAFYF/opbSnr6j3bTWc
fFqK1qI4mfN4i/RN0iAL3gTujJtHgXINwBQy7zBZLq7gcfJW5GqXb5JQbZaNaHqa
sjYUegbyJLkJEVDXCLG4iXqEI2FCKeWjzaIgQdfRnGTZ6iahixTXTBmyUEFxPT9N
cCOGDErcgdLMMpSEDQgJlxxPwO5rIHQw0uA5NBCFIRUBCOhVMt5xSdkoF1BN5r5N
0XWs0Mr7QbhDparTwwVETyw2m+L64kW4I1NsBm9nVX9GtUw/bihaeSbSpKhil9Ie
4u1Ki7wb/UdKDd9nZn6yW0HQO+T0O/QEY+nvwlQAUaCKKsnOeMzV6ocEGLPOr0mI
r/OSmbaz5mEP0oUA51Aa5BuVnRmhuZyxm7EAHu/QD09CbMkKvO5D+jpxpchNJqU1
/YldvIViHTLSoCtU7ZpXwdv6EM8Zt4tKG48BtieVU+i2iW1bvGjUI+iLUaJW+fCm
gKDWHrO8Dw9TdSmq6hN35N6MgSGtBxBHEa2HPQfRdbzP82Z+
-----END CERTIFICATE-----
`;

export const SECTIGO_ROOT_PEM = `# Sectigo Public Time Stamping Root R46 (self-signed), the root of the Sectigo timestamp chain.
# Subject: C=GB, O=Sectigo Limited, CN=Sectigo Public Time Stamping Root R46
# SHA-256 fingerprint: 49:41:B0:01:B8:A9:7E:96:1B:78:17:C9:D9:E9:60:EC:4B:05:6B:FC:91:5A:8C:1A:AB:F6:EF:6B:3A:C0:46:A5
# Valid: 2021-03-22 to 2046-03-21
# Published list: the Common CA Database (CCADB) record for this root, disclosed by CA owner Sectigo
#   (https://ccadb.my.salesforce-sites.com/ccadb/AllCertificateRecordsCSVFormatv4, row
#   "Sectigo Public Time Stamping Root R46", Apple and Microsoft status Included). Sectigo's own knowledge-base
#   pages do not list its time stamping roots.
# Download: http://crt.sectigo.com/SectigoPublicTimeStampingRootR46.crt (the AIA URL of the CA R41 certificate in a token)
# Cross-check: the chain in a live token from http://timestamp.sectigo.com on 2026-10-20 ends at this subject
#   (the token also carries copies cross-signed by USERTrust and AAA Certificate Services, which are not trusted here).
# Pinned 2026-10-20. Do not edit the certificate; replace it only after re-checking the published list.
-----BEGIN CERTIFICATE-----
MIIFejCCA2KgAwIBAgIQeD0FbPqDLn5p+FYidp8CuTANBgkqhkiG9w0BAQwFADBX
MQswCQYDVQQGEwJHQjEYMBYGA1UEChMPU2VjdGlnbyBMaW1pdGVkMS4wLAYDVQQD
EyVTZWN0aWdvIFB1YmxpYyBUaW1lIFN0YW1waW5nIFJvb3QgUjQ2MB4XDTIxMDMy
MjAwMDAwMFoXDTQ2MDMyMTIzNTk1OVowVzELMAkGA1UEBhMCR0IxGDAWBgNVBAoT
D1NlY3RpZ28gTGltaXRlZDEuMCwGA1UEAxMlU2VjdGlnbyBQdWJsaWMgVGltZSBT
dGFtcGluZyBSb290IFI0NjCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIB
AIid2LlFZ50d3ei5JoGaVFTAfEkFm8xaFQ/ZlBBEtEFAgXcUmanU5HYsyAhTXiDQ
kiUvpVdYqZ1uYoZEMgtHES1l1Cc6HaqZzEbOOp6YiTx63ywTon434aXVydmhx7Dx
4IBrAou7hNGsKioIBPy5GMN7KmgYmuu4f92sKKjbxqohUSfjk1mJlAjthgF7Hjx4
vvyVDQGsd5KarLW5d73E3ThobSkob2SL48LpUR/O627pDchxll+bTSv1gASn/hp6
IuHJorEu6EopoB1CNFp/+HpTXeNARXUmdRMKbnXWflq+/g36NJXB35ZvxQw6zid6
1qmrlD/IbKJA6COw/8lFSPQwBP1ityZdwuCysCKZ9ZjczMqbUcLFyq6KdOpuzVDR
3ZUwxDKL1wCAxgL2Mpz7eZbrb/JWXiOcNzDpQsmwGQ6Stw8tTCqPumhLRPb7YkzM
8/6NnWH3T9ClmcGSF22LEyJYNWCHrQqYubNeKolzqUbCqhSqmr/UdUeb49zYHr7A
LL8bAJyPDmubNqMtuaobKASBqP84uhqcRY/pjnYd+V5/dcu9ieERjiRKKsxCG1t6
tG9oj7liwPddXEcYGOUiWLm742st50jGwTzxbMpepmOP1mLnJskvZaN5e45NuzAH
teORlsSuDt5t4BBRCJL+5EZnnw0ezntk9R8QJyAkL6/bAgMBAAGjQjBAMB0GA1Ud
DgQWBBT2d2rdP/0BE/8WoWyCAi/QCj0UJTAOBgNVHQ8BAf8EBAMCAYYwDwYDVR0T
AQH/BAUwAwEB/zANBgkqhkiG9w0BAQwFAAOCAgEACv68sZqZvmHk7JoU7AfTEZ7b
X45u40OrLX/6vzHQAwDg1TB00bWbiwj+7+we60BP8AMsw1h5NCXWxeyvrEVC54Mi
rwVrcF6SFGjRwRoelRuiaZ5FDO4oWhaePjZx3/jkQ7j653CA5WscYqlneLXBEZiY
o6rRNqnsZHZTQ606mlkNpsy3TFMADv5whZmilVEZ83OvydfH2DNL3FTkpZG7+lHS
1DFHMSUB5UtSSeSRg2UWTXwU5oObGjFk/35fC/dlF+nJIXdqsw0TZSS86bi5GRCJ
VjqjnkpZ0Jut7ucEv4PNOIU8ijkMRj17QPjHMtdy+WxBDDSdas/UFTVB/GF+Fofn
OD3iZ4tXxFjPU3EWRcMWx8fcGyzlBfcjeoPNbNC7wfyV9Qkzfk2Bd48jGxG7OThY
Wolc56vmBHqDEfguDwYc9AeWirMVRDi+WYlsktzAEObiFoPqs+LWU5q7+Q1+nEcs
tNuDIedeBRcHmtjL2hV3luuEWwDSnRhSjhPLPXzqpJ1rG3r4yqm1NjKg5A5QO9Az
veHqRQldluTSKuu96oPEPusL2oF+4MxkJ+SQMGFWTw/PNCblUN8GXeL5+mR20diP
5LiJMq8U3IpM/0Q7OFFQ+lXuYFIuDvUprWBPsp5La2WhL2+iLVVXItSl7up5yQqX
XftzTXTX48FRiJ6PA9o=
-----END CERTIFICATE-----
`;
