const WIDGET = 20;

export async function buildForms(g, vals, onChange) {
  const anns = await g.p.getAnnotations({ intent: 'display' }).catch(() => []);
  const widgets = anns.filter(a => a.annotationType === WIDGET && a.fieldName && !a.hidden && !a.pushButton && ['Tx', 'Btn', 'Ch'].includes(a.fieldType));
  g.forms.replaceChildren();
  for (const a of widgets) {
    const [x1, y1, x2, y2] = g.vp.convertToViewportRectangle(a.rect);
    const x = Math.min(x1, x2), y = Math.min(y1, y2), w = Math.abs(x2 - x1), h = Math.abs(y2 - y1);
    const name = a.fieldName, saved = vals[name];
    let f;
    if (a.fieldType === 'Tx') {
      f = document.createElement(a.multiLine ? 'textarea' : 'input');
      f.value = saved ?? a.fieldValue ?? '';
      if (a.maxLen) f.maxLength = a.maxLen;
      f.oninput = () => onChange(name, f.value, f);
    } else if (a.fieldType === 'Ch') {
      f = document.createElement('select');
      for (const o of a.options || []) f.append(new Option(o.displayValue, o.exportValue));
      f.value = saved ?? (Array.isArray(a.fieldValue) ? a.fieldValue[0] : a.fieldValue) ?? '';
      f.onchange = () => onChange(name, f.value, f);
    } else if (a.checkBox) {
      f = Object.assign(document.createElement('input'), { type: 'checkbox' });
      f.checked = saved ?? (!!a.fieldValue && a.fieldValue !== 'Off');
      f.onchange = () => onChange(name, f.checked, f);
    } else if (a.radioButton) {
      f = Object.assign(document.createElement('input'), { type: 'radio', name: 'field:' + name, value: a.buttonValue });
      f.checked = (saved ?? a.fieldValue) === a.buttonValue;
      f.onchange = () => onChange(name, a.buttonValue, f);
    } else continue;
    f.className = 'field';
    f.dataset.name = name;
    f.disabled = !!a.readOnly;
    f.setAttribute('aria-label', a.alternativeText || name);
    const size = a.defaultAppearanceData?.fontSize || Math.min(h * 0.7, 12);
    Object.assign(f.style, { left: x + 'px', top: y + 'px', width: w + 'px', height: h + 'px', fontSize: size + 'px' });
    g.forms.append(f);
  }
  return widgets.length > 0;
}

export function fillPdfForm(out, vals, chars) {
  if (!Object.keys(vals).length) return;
  let form;
  try { form = out.getForm(); } catch { return; }
  const { PDFTextField, PDFCheckBox, PDFRadioGroup, PDFDropdown, PDFOptionList } = PDFLib;
  for (const [name, v] of Object.entries(vals)) {
    try {
      const f = form.getField(name);
      if (f instanceof PDFTextField) f.setText([...String(v)].map(ch => ch === '\n' || chars.has(ch.codePointAt(0)) ? ch : '?').join(''));
      else if (f instanceof PDFCheckBox) v ? f.check() : f.uncheck();
      else if (f instanceof PDFRadioGroup || f instanceof PDFDropdown || f instanceof PDFOptionList) f.select(v);
    } catch (err) {
      console.warn('Campo non aggiornato', name, err.message);
    }
  }
}
