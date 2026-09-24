window.ReadProofAPI = (() => {
  const base = 'https://frog02-32287.wykr.es/api';

  function url(path) {
    const value = String(path || '');
    if (/^https?:\/\//i.test(value)) return value;
    const suffix = value.replace(/^\/api(?=\/|$)/, '').replace(/^\//, '');
    return `${base}${suffix ? `/${suffix}` : ''}`;
  }

  async function request(path, options = {}) {
    const response = await fetch(url(path), options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || `HTTP ${response.status}`);
      error.status = response.status;
      error.body = data;
      throw error;
    }
    return data;
  }

  return Object.freeze({ base, url, request });
})();
