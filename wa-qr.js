const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
} = require("@whiskeysockets/baileys");
const qrcode = require("qrcode-terminal");
const pino = require("pino");

async function startQrSession() {
    const {
        state,
        saveCreds
    } = await useMultiFileAuthState("auth_info");

    const sock = makeWASocket({
        auth: state,
        logger: pino({
            level: "silent"
        }),
        browser: ["QR-Generator", "Chrome", "20.0.0"],
    });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", ({
        connection,
        lastDisconnect,
        qr
    }) => {
        if (qr) {
            console.clear();
            console.log("Scan QR berikut dengan WhatsApp kamu:\n");
            qrcode.generate(qr, {
                small: true
            });
        }

        if (connection === "open") {
            console.log("WhatsApp berhasil terhubung. Session tersimpan di folder auth_info.");
            process.exit(0);
        }

        if (connection === "close") {
            const code = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = code !== DisconnectReason.loggedOut;

            if (shouldReconnect) {
                console.log("Koneksi terputus, mencoba koneksi ulang...");
                startQrSession().catch((error) => {
                    console.error("Gagal reconnect:", error.message);
                    process.exit(1);
                });
                return;
            }

            console.error("Session logout. Hapus folder auth_info lalu jalankan lagi untuk scan QR baru.");
            process.exit(1);
        }
    });
}

startQrSession().catch((error) => {
    console.error("Gagal menjalankan generator QR:", error.message);
    process.exit(1);
});
