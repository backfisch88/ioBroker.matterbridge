/* Bewusst simpel gehalten: kein Socket.IO, keine Abhaengigkeit von
   globalen Admin-Variablen. Zeigt das Matterbridge-Frontend direkt an,
   Port per URL-Query ?port= ueberschreibbar (Default 8283). */

function showError(msg) {
    const status = document.getElementById('mb-status');
    status.textContent = msg;
    status.style.display = 'block';
    document.getElementById('mb-frame').style.display = 'none';
}

function showFrame(url) {
    const frame = document.getElementById('mb-frame');
    const status = document.getElementById('mb-status');
    frame.src = url;
    frame.style.display = 'block';
    status.style.display = 'none';
}

try {
    const params = new URLSearchParams(window.location.search);
    const port = params.get('port') || '8283';
    const host = window.location.hostname;
    showFrame(`http://${host}:${port}/`);
} catch (e) {
    showError(`Fehler: ${e.message}`);
}
