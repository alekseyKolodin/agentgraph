// Файл из <input type="file"> или перетаскивания → base64 без префикса data:…, как его ждут POST /api/runs и вложения тега.
export const readBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
