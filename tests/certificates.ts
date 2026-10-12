import forge from "node-forge";
export function certificates(host = "api.anthropic.com") {
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const ca = forge.pki.createCertificate();
  ca.publicKey = keys.publicKey;
  ca.serialNumber = "01";
  ca.validity.notBefore = new Date(Date.now() - 60_000);
  ca.validity.notAfter = new Date(Date.now() + 86_400_000);
  ca.setSubject([{ name: "commonName", value: "Test CA" }]);
  ca.setIssuer(ca.subject.attributes);
  ca.setExtensions([
    { name: "basicConstraints", cA: true },
    { name: "keyUsage", keyCertSign: true },
  ]);
  ca.sign(keys.privateKey, forge.md.sha256.create());
  const leaf = forge.pki.createCertificate();
  leaf.publicKey = keys.publicKey;
  leaf.serialNumber = "02";
  leaf.validity.notBefore = ca.validity.notBefore;
  leaf.validity.notAfter = ca.validity.notAfter;
  leaf.setSubject([{ name: "commonName", value: host }]);
  leaf.setIssuer(ca.subject.attributes);
  leaf.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: host },
        { type: 7, ip: "127.0.0.1" },
      ],
    },
  ]);
  leaf.sign(keys.privateKey, forge.md.sha256.create());
  return {
    caPem: forge.pki.certificateToPem(ca),
    cert: forge.pki.certificateToPem(leaf),
    key: forge.pki.privateKeyToPem(keys.privateKey),
  };
}
