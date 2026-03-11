import {
    Table,
    Column,
    CreatedAt,
    UpdatedAt,
    Model,
    PrimaryKey,
    AutoIncrement,
    AllowNull,
    Unique,
    Default,
    ForeignKey,
    BelongsTo,
    HasMany,
    BeforeCreate,
    BeforeUpdate
} from "sequelize-typescript";
import bcrypt from "bcryptjs";
import Company from "./Company";
import Ticket from "./Ticket";
import Whatsapp from "./Whatsapp";

@Table({ tableName: "users" })
class User extends Model {
    @PrimaryKey
    @AutoIncrement
    @Column
    id: number;

    @AllowNull(false)
    @Column
    name: string;

    @AllowNull(false)
    @Unique
    @Column
    email: string;

    @AllowNull(false)
    @Column
    passwordHash: string;

    @Default("user")
    @Column
    profile: string; // 'admin' | 'user'

    @ForeignKey(() => Company)
    @AllowNull(false)
    @Column
    companyId: number;

    @BelongsTo(() => Company)
    company: Company;

    @ForeignKey(() => Whatsapp)
    @Column
    whatsappId: number;

    @BelongsTo(() => Whatsapp)
    whatsapp: Whatsapp;

    @HasMany(() => Ticket)
    tickets: Ticket[];

    @CreatedAt
    createdAt: Date;

    @UpdatedAt
    updatedAt: Date;

    @BeforeUpdate
    @BeforeCreate
    static hashPassword = async (instance: User): Promise<void> => {
        if (instance.changed("passwordHash") && instance.passwordHash) {
            instance.passwordHash = await bcrypt.hash(instance.passwordHash, 10);
        }
    };

    public checkPassword = async (password: string): Promise<boolean> => {
        return bcrypt.compare(password, this.passwordHash);
    };
}

export default User;
