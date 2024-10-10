// Додаємо обробник події для форми
document.getElementById('character-form').addEventListener('submit', function(e) {
    e.preventDefault(); // Запобігаємо стандартному відправленню форми

    // Отримуємо значення з полів форми
    var name = document.getElementById('name').value;
    var race = document.getElementById('race').value;
    var className = document.getElementById('class').value;
    var level = document.getElementById('level').value;

    // Створюємо об'єкт персонажа
    var character = {
        name: name,
        race: race,
        class: className,
        level: level
    };

    // Зберігаємо персонажа в локальному сховищі
    localStorage.setItem('character', JSON.stringify(character));

    // Повідомляємо користувача про успішне збереження
    alert('Персонаж успішно збережений!');
});

// Завантажуємо персонажа при завантаженні сторінки (опціонально)
window.onload = function() {
    var savedCharacter = localStorage.getItem('character');
    if (savedCharacter) {
        var character = JSON.parse(savedCharacter);
        document.getElementById('name').value = character.name;
        document.getElementById('race').value = character.race;
        document.getElementById('class').value = character.class;
        document.getElementById('level').value = character.level;
    }
};