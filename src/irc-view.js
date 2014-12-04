window.addEventListener('load', function () {
  "use strict";
  var form = document.getElementsByTagName('form')[0];
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    var credentials = {
      userId: form.userId.value,
      host: form.host.value,
      port: form.port.value || 66667
    };
    parent.postMessage({cmd: 'auth', message: credentials}, '*');
    return false;
  }, true);

  window.addEventListener('message', function (m) {
    document.getElementById('status').innerText = m;
  }, true);
}, true);
