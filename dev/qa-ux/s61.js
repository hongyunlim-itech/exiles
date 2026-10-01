const rows = await page.evaluate(()=>[...document.querySelectorAll('.w-professions *')].filter(e=>/^Hunter$/.test(e.innerText?.trim())).map(e=>({cls:e.className, r:e.getBoundingClientRect().toJSON()})));
return rows;
