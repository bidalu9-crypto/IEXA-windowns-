(function () {
  async function json(path, options) {
    const response = await fetch(path, options);
    const data = await response.json().catch(function () { return {}; });
    if (!response.ok) throw new Error(data.error || ('' + IexaI18n.t('prompt.requestFailed') + '：' + response.status));
    return data;
  }

  window.IexaApi = { json: json };
}());
