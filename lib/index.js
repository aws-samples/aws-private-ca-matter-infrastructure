const { ACMPCAClient, DescribeCertificateAuthorityCommand } = require("@aws-sdk/client-acm-pca");

function is4DigitHexNumber(value) {
    // The values SHALL be encoded in network byte order as exactly twice their specified maximum octet length, encoded as uppercase
    // hexadecimal number format without any separators or prefix, and without omitting any leading zeroes.
    return /^[0-9A-F]{4}$/.test(value);
}

exports.handler = async function(event, context) {
    if (event.RequestType === "Delete") {
        return {};
    }

    const userMsg = "should be 4-digit hexadecimal number in all capitals";

    switch (event.ResourceProperties.command) {
        case "getPaaVendorId":
            const pcaClient = new ACMPCAClient({
                region: event.ResourceProperties.paaRegion
            });
            const cmd = new DescribeCertificateAuthorityCommand({
                CertificateAuthorityArn: event.ResourceProperties.paaArn
            });
            const response = await pcaClient.send(cmd);
            const ca = response.CertificateAuthority;
            const vidAttribute = ca.CertificateAuthorityConfiguration.Subject
                .CustomAttributes.find(id => id.ObjectIdentifier === "1.3.6.1.4.1.37244.2.1");
            if (vidAttribute === undefined) {
                throw new Error('Provided PAA isn\'t VID-scoped (no Custom Attribute found in its Subject)');
            }
            const vid = vidAttribute.Value;
            if (!is4DigitHexNumber(vid)) {
                throw new Error('Invalid PAA with VID ' + event.ResourceProperties.vid + ', ' + userMsg);
            }
            return { Data: { Result: vid } };

        case "validateVidPid":
            if (event.ResourceProperties.vid !== undefined && !is4DigitHexNumber(event.ResourceProperties.vid)) {
                throw new Error('Invalid VID ' + event.ResourceProperties.vid + ', ' + userMsg);
            }
            if (event.ResourceProperties.pids !== undefined && !event.ResourceProperties.pids.every((val) => is4DigitHexNumber(val))) {
                throw new Error('Invalid PIDs [' + event.ResourceProperties.pids + '], each ' + userMsg);
            }

            return {
                Data: {
                    vid: event.ResourceProperties.vid,
                    pids: event.ResourceProperties.pids
                }
            };
    }

    throw new Error('UNKNOWN COMMAND ' + event.ResourceProperties.command);
};