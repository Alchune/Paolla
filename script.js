const STORAGE_KEY = 'vtm5_ua_character_sheet';

const form = document.getElementById('character-form');
const clearBtn = document.getElementById('clear-btn');

const enableOneDotToggleToEmpty = () => {
    const oneDotLabels = document.querySelectorAll('.dot-rating label[for$="_1"]');

    oneDotLabels.forEach((label) => {
        label.addEventListener('click', (event) => {
            const targetInput = document.getElementById(label.htmlFor);
            if (targetInput && targetInput.checked) {
                event.preventDefault();
                targetInput.checked = false;
            }
        });
    });
};

const restoreForm = () => {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;

    try {
        const values = JSON.parse(raw);
        Object.entries(values).forEach(([name, value]) => {
            const field = form.elements.namedItem(name);
            if (field) {
                field.value = value;
            }
        });
    } catch (error) {
        console.error('Не вдалося відновити дані чарлиста:', error);
    }
};

form.addEventListener('submit', (event) => {
    event.preventDefault();

    const payload = Object.fromEntries(new FormData(form).entries());
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));

    alert('Чарлист збережено в локальному сховищі браузера.');
});

clearBtn.addEventListener('click', () => {
    form.reset();
    localStorage.removeItem(STORAGE_KEY);
});

enableOneDotToggleToEmpty();
restoreForm();
